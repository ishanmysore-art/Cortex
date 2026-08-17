/**
 * Proactive notices and the response loop.
 *
 * The loop is what these tests are mostly about. Detection is a query over
 * projections that already exist and is easy to get right; a dismissal that
 * fails to suppress, or a response that is never recorded, is the failure that
 * cannot be repaired afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.sql.exec(`
    DELETE FROM public.notices;
    DELETE FROM public.knowledge_states;
    DELETE FROM public.concept_mentions;
    DELETE FROM public.concept_edges;
    DELETE FROM public.concepts;
    DELETE FROM public.observations;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
  `);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

const TEXT = "Working memory capacity predicts reading comprehension in ADHD participants.";

async function seedDocument(userId: string, title: string, createdAt: string, chunks = 1) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path, created_at)
       VALUES ($1,$2,'pdf','ready',$3,$4) RETURNING id`,
      [userId, title, `${userId}/${title}`, createdAt],
    )
  ).rows[0].id;

  const chunkIds: string[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const { rows } = await db.sql.query<{ id: string }>(
      `INSERT INTO public.document_chunks (document_id, chunk_index, content, page_start, page_end)
       VALUES ($1,$2,$3,1,1) RETURNING id`,
      [documentId, index, TEXT],
    );
    chunkIds.push(rows[0].id);
  }
  return { documentId, chunkIds };
}

function mention(chunkId: string, surfaceForm: string) {
  const charStart = TEXT.indexOf(surfaceForm);
  return { chunkId, surfaceForm, charStart, charEnd: charStart + surfaceForm.length };
}

async function syncConcepts(
  userId: string,
  documentId: string,
  candidates: Array<{ label: string; canonicalKey: string; mentions: ReturnType<typeof mention>[] }>,
) {
  await db.sql.query(`SELECT public.sync_document_concepts($1,$2,$3::jsonb,0.95)`, [
    userId,
    documentId,
    JSON.stringify(candidates),
  ]);
}

/** Two concepts co-occurring in the same passages across `documents` documents. */
async function seedCoOccurrence(userId: string, documents: number, chunksEach: number) {
  for (let index = 0; index < documents; index += 1) {
    const { documentId, chunkIds } = await seedDocument(
      userId,
      `paper-${index}.pdf`,
      `2026-0${index + 1}-01T00:00:00.000Z`,
      chunksEach,
    );
    await syncConcepts(userId, documentId, [
      {
        label: "working memory",
        canonicalKey: "working memory",
        mentions: chunkIds.map((id) => mention(id, "Working memory")),
      },
      {
        label: "attention deficit hyperactivity disorder",
        canonicalKey: "adhd",
        mentions: chunkIds.map((id) => mention(id, "ADHD")),
      },
    ]);
  }
}

const detect = (userId: string) =>
  db.sql
    .query<{ r: Record<string, number> }>(`SELECT public.detect_notices($1) AS r`, [userId])
    .then((res) => res.rows[0].r);

const notices = async (userId?: string) =>
  (
    await db.sql.query<{
      id: string;
      kind: string;
      subject_key: string;
      payload: Record<string, unknown>;
      confidence_method: string;
      response: string;
      surfaced_at: Date | null;
      responded_at: Date | null;
    }>(
      `SELECT * FROM public.notices
       WHERE ($1::uuid IS NULL OR user_id = $1) ORDER BY kind, subject_key`,
      [userId ?? null],
    )
  ).rows;

const countRows = async (table: string, where = "TRUE", params: unknown[] = []) =>
  Number(
    (
      await db.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${table} WHERE ${where}`,
        params,
      )
    ).rows[0].count,
  );

// ---------------------------------------------------------------------------

describe("detection thresholds", () => {
  it("raises a connection for concepts sharing passages across documents", async () => {
    await seedCoOccurrence(alice, 2, 2);
    const summary = await detect(alice);
    expect(summary.connections).toBe(1);

    const [notice] = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(notice.payload.documentCount).toBe(2);
    expect(notice.payload.passageCount).toBe(4);
    // The notice is its own evidence: a counted statement, not a conclusion.
    expect(notice.confidence_method).toMatch(/appear together in 4 passages across 2 of your documents/);
  });

  it("stays silent when the pair shares only one document", async () => {
    await seedCoOccurrence(alice, 1, 4);
    expect((await detect(alice)).connections).toBe(0);
  });

  it("stays silent when the pair shares too few passages", async () => {
    await seedCoOccurrence(alice, 2, 1);
    // Two documents but only two shared passages, under the floor of three.
    expect((await detect(alice)).connections).toBe(0);
  });

  it("raises a recurring concept only across enough documents and time", async () => {
    for (const [index, date] of ["2026-01-01", "2026-02-15", "2026-04-20"].entries()) {
      const { documentId, chunkIds } = await seedDocument(
        alice,
        `doc-${index}.pdf`,
        `${date}T00:00:00.000Z`,
      );
      await syncConcepts(alice, documentId, [
        {
          label: "working memory",
          canonicalKey: "working memory",
          mentions: [mention(chunkIds[0], "Working memory")],
        },
      ]);
    }

    const summary = await detect(alice);
    expect(summary.recurring).toBe(1);
    const [notice] = (await notices()).filter((n) => n.kind === "recurring_concept");
    expect(notice.payload.documentCount).toBe(3);
    expect(notice.confidence_method).toMatch(/appears in 3 of your documents/);
    expect(notice.confidence_method).toMatch(/2026-01-01.*2026-04-20/);
  });

  it("stays silent when a concept recurs inside too short a span", async () => {
    for (const [index, date] of ["2026-01-01", "2026-01-05", "2026-01-10"].entries()) {
      const { documentId, chunkIds } = await seedDocument(
        alice,
        `doc-${index}.pdf`,
        `${date}T00:00:00.000Z`,
      );
      await syncConcepts(alice, documentId, [
        {
          label: "working memory",
          canonicalKey: "working memory",
          mentions: [mention(chunkIds[0], "Working memory")],
        },
      ]);
    }
    expect((await detect(alice)).recurring).toBe(0);
  });

  it("produces nothing at all on a young corpus", async () => {
    // The cold-start gate is the thresholds themselves, not a date: a thin
    // corpus yields silence rather than noise.
    const { documentId, chunkIds } = await seedDocument(alice, "one.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [
      {
        label: "working memory",
        canonicalKey: "working memory",
        mentions: [mention(chunkIds[0], "Working memory")],
      },
    ]);
    expect(await detect(alice)).toEqual({ connections: 0, recurring: 0 });
    expect(await notices()).toHaveLength(0);
  });

  it("is idempotent across repeated detection", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    await detect(alice);
    await detect(alice);
    expect((await notices()).filter((n) => n.kind === "concept_connection")).toHaveLength(1);
  });

  it("refreshes the counts on a notice the user has not answered yet", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const before = (await notices()).find((n) => n.kind === "concept_connection")!;
    expect(before.payload.passageCount).toBe(4);

    await seedCoOccurrence(alice, 3, 2);
    await detect(alice);
    const after = (await notices()).find((n) => n.kind === "concept_connection")!;
    // Showing stale numbers on something nobody has seen yet helps nobody.
    expect(Number(after.payload.passageCount)).toBeGreaterThan(4);
  });

  it("names the pair in a stable order regardless of concept ids", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const [notice] = (await notices()).filter((n) => n.kind === "concept_connection");
    // Built from canonical keys, ordered, so the key is reproducible.
    expect(notice.subject_key).toBe("concept_connection:adhd|working memory");
  });
});

describe("the response loop", () => {
  async function seedOneNotice() {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    return (await notices()).find((n) => n.kind === "concept_connection")!;
  }

  it("records surfacing separately from detection", async () => {
    const notice = await seedOneNotice();
    expect(notice.surfaced_at).toBeNull();
    expect(await countRows("observations", "event_type = 'notice_surfaced'")).toBe(0);

    await db.asUser(alice, () => db.sql.query(`SELECT public.mark_my_notices_surfaced()`));

    const [after] = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after.surfaced_at).not.toBeNull();
    // "Cortex detected this" and "the user saw it" are different facts; without
    // both, a dismissal rate cannot be interpreted.
    expect(await countRows("observations", "event_type = 'notice_surfaced'")).toBe(1);
  });

  it("does not re-record surfacing on a second visit", async () => {
    await seedOneNotice();
    await db.asUser(alice, () => db.sql.query(`SELECT public.mark_my_notices_surfaced()`));
    await db.asUser(alice, () => db.sql.query(`SELECT public.mark_my_notices_surfaced()`));
    expect(await countRows("observations", "event_type = 'notice_surfaced'")).toBe(1);
  });

  it("records a dismissal in the log", async () => {
    const notice = await seedOneNotice();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'dismissed')`, [notice.id]),
    );

    const [after] = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after.response).toBe("dismissed");
    expect(after.responded_at).not.toBeNull();

    const { rows } = await db.sql.query<{ source_id: string; payload: { kind: string } }>(
      `SELECT source_id, payload FROM public.observations WHERE event_type = 'notice_dismissed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(notice.id);
    expect(rows[0].payload.kind).toBe("concept_connection");
  });

  it("records an acceptance in the log", async () => {
    const notice = await seedOneNotice();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'accepted')`, [notice.id]),
    );
    expect(await countRows("observations", "event_type = 'notice_accepted'")).toBe(1);
  });

  it("treats responding as having seen it", async () => {
    const notice = await seedOneNotice();
    // The user answered before any surfacing pass ran.
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'dismissed')`, [notice.id]),
    );
    const [after] = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after.surfaced_at).not.toBeNull();
  });

  it("rejects an unsupported response", async () => {
    const notice = await seedOneNotice();
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`SELECT public.respond_to_notice($1,'snoozed')`, [notice.id]),
      ),
    ).rejects.toThrow(/Unsupported notice response/);
  });

  it("requires a response to be timestamped", async () => {
    await seedOneNotice();
    await expect(
      db.sql.query(`UPDATE public.notices SET response = 'dismissed'`),
    ).rejects.toThrow(/notices_response_timed/);
  });
});

describe("a dismissal is permanent", () => {
  it("never recreates a dismissed notice, however much evidence accumulates", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const notice = (await notices()).find((n) => n.kind === "concept_connection")!;
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'dismissed')`, [notice.id]),
    );

    // Far more evidence than first triggered it.
    await seedCoOccurrence(alice, 4, 3);
    await detect(alice);

    const after = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after).toHaveLength(1);
    expect(after[0].response).toBe("dismissed");
    // Re-offering something already rejected is how a proactive feature burns trust.
    expect(after[0].id).toBe(notice.id);
  });

  it("does not refresh the counts on a dismissed notice", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const notice = (await notices()).find((n) => n.kind === "concept_connection")!;
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'dismissed')`, [notice.id]),
    );

    await seedCoOccurrence(alice, 4, 3);
    await detect(alice);
    const after = (await notices()).find((n) => n.kind === "concept_connection")!;
    expect(after.payload.passageCount).toBe(notice.payload.passageCount);
  });

  it("survives the concepts behind it being pruned and recreated", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const notice = (await notices()).find((n) => n.kind === "concept_connection")!;
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'dismissed')`, [notice.id]),
    );

    // Wipe the concept graph and rebuild it: every concept gets a new row id.
    await db.sql.query(`DELETE FROM public.documents WHERE user_id = $1`, [alice]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);

    // Keying the notice on concept ids would have let the dismissal lapse here.
    const after = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after).toHaveLength(1);
    expect(after[0].response).toBe("dismissed");
  });

  it("keeps an accepted notice rather than re-raising it", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const notice = (await notices()).find((n) => n.kind === "concept_connection")!;
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.respond_to_notice($1,'accepted')`, [notice.id]),
    );

    await detect(alice);
    const after = (await notices()).filter((n) => n.kind === "concept_connection");
    expect(after).toHaveLength(1);
    expect(after[0].response).toBe("accepted");
  });
});

describe("isolation", () => {
  it("never detects on another user's material", async () => {
    await seedCoOccurrence(bob, 2, 2);
    expect(await detect(alice)).toEqual({ connections: 0, recurring: 0 });
    expect(await countRows("notices", "user_id = $1", [alice])).toBe(0);
  });

  it("never shows one user another's notices", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);

    const visible = await db.asUser(bob, async () =>
      (await db.sql.query(`SELECT id FROM public.notices`)).rows,
    );
    expect(visible).toHaveLength(0);

    const own = await db.asUser(alice, async () =>
      (await db.sql.query(`SELECT id FROM public.notices`)).rows,
    );
    expect(own.length).toBeGreaterThan(0);
  });

  it("cannot respond to another user's notice", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    const notice = (await notices()).find((n) => n.kind === "concept_connection")!;

    const result = await db.asUser(bob, async () =>
      (
        await db.sql.query<{ r: { updated: number } }>(
          `SELECT public.respond_to_notice($1,'dismissed') AS r`,
          [notice.id],
        )
      ).rows[0].r,
    );
    expect(result.updated).toBe(0);
    expect((await notices()).find((n) => n.id === notice.id)!.response).toBe("pending");
  });

  it("blocks forging or editing a notice", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);

    await expect(
      db.asUser(alice, () =>
        db.sql.query(
          `INSERT INTO public.notices (user_id, kind, subject_key, confidence_method)
           VALUES ($1,'concept_connection','forged','forged')`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      db.asUser(alice, () => db.sql.query(`UPDATE public.notices SET response = 'accepted'`)),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("keeps detection out of reach of ordinary users", async () => {
    await expect(
      db.asUser(alice, () => db.sql.query(`SELECT public.detect_notices($1)`, [bob])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("detects only for the caller through the authenticated wrapper", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await seedCoOccurrence(bob, 2, 2);
    await db.asUser(alice, () => db.sql.query(`SELECT public.refresh_my_notices()`));

    expect(await countRows("notices", "user_id = $1", [alice])).toBeGreaterThan(0);
    expect(await countRows("notices", "user_id = $1", [bob])).toBe(0);
  });

  it("removes notices with the account", async () => {
    await seedCoOccurrence(alice, 2, 2);
    await detect(alice);
    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    expect(await countRows("notices")).toBe(0);
  });
});

describe("scope boundary", () => {
  it("raises no notice that judges what the user knows", async () => {
    await seedCoOccurrence(alice, 3, 3);
    await detect(alice);

    const forbidden =
      /(gap|mastery|weak|struggl|forget|rusty|should (learn|review|study)|you don'?t|proficien)/i;
    for (const notice of await notices()) {
      expect(notice.kind).not.toMatch(forbidden);
      // Every notice is a counted statement about the user's own material.
      expect(notice.confidence_method).not.toMatch(forbidden);
      expect(notice.confidence_method).toMatch(/\d/);
    }
  });
});
