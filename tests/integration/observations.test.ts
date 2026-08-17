/**
 * Database-level tests for the observation spine.
 *
 * These run the real migration files under supabase/migrations against an
 * embedded Postgres, so RLS policies, CHECK constraints, indexes, and triggers
 * are exercised as shipped rather than mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildObservationRow } from "../../lib/observations";
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
  await db.sql.exec(`DELETE FROM public.observations;`);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

/** Inserts through the same column shape the application recorder produces. */
async function insertObservation(
  userId: string,
  overrides: Partial<Parameters<typeof buildObservationRow>[0]> = {},
) {
  const row = buildObservationRow({
    userId,
    eventType: "search_performed",
    payload: { query: "sleep", resultCount: 2, topSimilarity: 0.7 },
    ...overrides,
  } as Parameters<typeof buildObservationRow>[0]);

  const result = await db.sql.query<{ id: string }>(
    `INSERT INTO public.observations
       (user_id, event_type, event_category, actor, source_type, source_id,
        occurred_at, context, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      row.user_id,
      row.event_type,
      row.event_category,
      row.actor,
      row.source_type,
      row.source_id,
      row.occurred_at,
      JSON.stringify(row.context),
      JSON.stringify(row.payload),
      row.dedupe_key,
    ],
  );
  return result.rows[0].id;
}

describe("observations schema", () => {
  it("accepts the exact row shape the application recorder builds", async () => {
    // Links the TypeScript layer to the shipped schema: a drift in either side
    // fails here rather than in production.
    const id = await insertObservation(alice, {
      eventType: "question_asked",
      sourceId: "33333333-3333-4333-8333-333333333333",
      context: { conversationId: "44444444-4444-4444-8444-444444444444" },
      payload: { characterCount: 20, isFollowUp: false },
      dedupeKey: "question_asked:33333333-3333-4333-8333-333333333333",
    });

    const { rows } = await db.sql.query<{
      event_category: string;
      actor: string;
      source_type: string;
      payload: { characterCount: number };
    }>(`SELECT event_category, actor, source_type, payload FROM public.observations WHERE id = $1`, [id]);

    expect(rows[0]).toMatchObject({
      event_category: "interaction",
      actor: "user",
      source_type: "message",
    });
    expect(rows[0].payload.characterCount).toBe(20);
  });

  it("defaults both clocks and keeps them independently addressable", async () => {
    const occurredAt = new Date(Date.now() - 60_000);
    const id = await insertObservation(alice, { occurredAt });
    const { rows } = await db.sql.query<{ occurred_at: Date; recorded_at: Date }>(
      `SELECT occurred_at, recorded_at FROM public.observations WHERE id = $1`,
      [id],
    );
    expect(new Date(rows[0].occurred_at).getTime()).toBe(occurredAt.getTime());
    // recorded_at is when Cortex learned it, which is later than the event.
    expect(new Date(rows[0].recorded_at).getTime()).toBeGreaterThan(
      new Date(rows[0].occurred_at).getTime(),
    );
  });

  it("orders a timeline deterministically when timestamps collide", async () => {
    const sameMoment = new Date("2026-05-01T00:00:00.000Z");
    await insertObservation(alice, { occurredAt: sameMoment });
    await insertObservation(alice, { occurredAt: sameMoment });
    await insertObservation(alice, { occurredAt: new Date("2026-05-02T00:00:00.000Z") });

    const { rows } = await db.sql.query<{ id: string; occurred_at: Date }>(
      `SELECT id, occurred_at FROM public.observations
       WHERE user_id = $1 ORDER BY occurred_at DESC, id DESC`,
      [alice],
    );
    expect(rows).toHaveLength(3);
    expect(new Date(rows[0].occurred_at).toISOString()).toBe("2026-05-02T00:00:00.000Z");
    // The id tiebreak makes the remaining order total, so pagination is stable.
    expect(rows[1].id > rows[2].id).toBe(true);
  });

  it("rejects a payload that carries content instead of metadata", async () => {
    await expect(
      db.sql.query(
        `INSERT INTO public.observations
           (user_id, event_type, event_category, actor, source_type, payload)
         VALUES ($1,'search_performed','retrieval','user','system',$2)`,
        [alice, JSON.stringify({ query: "x".repeat(9_000) })],
      ),
    ).rejects.toThrow(/observations_payload_size/);
  });

  it("rejects a non-object payload", async () => {
    await expect(
      db.sql.query(
        `INSERT INTO public.observations
           (user_id, event_type, event_category, actor, source_type, payload)
         VALUES ($1,'search_performed','retrieval','user','system','"a string"'::jsonb)`,
        [alice],
      ),
    ).rejects.toThrow(/observations_payload_is_object/);
  });
});

describe("observations idempotency", () => {
  it("suppresses a repeat write carrying the same dedupe key", async () => {
    const insert = () =>
      db.sql.query(
        `INSERT INTO public.observations
           (user_id, event_type, event_category, actor, source_type, source_id, payload, dedupe_key)
         VALUES ($1,'document_uploaded','document','user','document',$2,'{}'::jsonb,$3)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [alice, "55555555-5555-4555-8555-555555555555", "document_uploaded:55555555"],
      );

    await insert();
    await insert();
    await insert();

    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations WHERE user_id = $1`,
      [alice],
    );
    expect(rows[0].count).toBe("1");
  });

  it("leaves events without a dedupe key unconstrained", async () => {
    await insertObservation(alice);
    await insertObservation(alice);
    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations WHERE dedupe_key IS NULL`,
    );
    expect(rows[0].count).toBe("2");
  });

  it("scopes the dedupe key per user so one user cannot block another's write", async () => {
    for (const user of [alice, bob]) {
      await db.sql.query(
        `INSERT INTO public.observations
           (user_id, event_type, event_category, actor, source_type, payload, dedupe_key)
         VALUES ($1,'search_performed','retrieval','user','system','{}'::jsonb,'shared-key')
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        [user],
      );
    }
    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations WHERE dedupe_key = 'shared-key'`,
    );
    expect(rows[0].count).toBe("2");
  });
});

describe("observations provenance", () => {
  it("survives deletion of the row it points at", async () => {
    const documentId = (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.documents (user_id, title, file_type, file_path)
         VALUES ($1,'paper.pdf','pdf','alice/paper.pdf') RETURNING id`,
        [alice],
      )
    ).rows[0].id;

    await insertObservation(alice, {
      eventType: "document_uploaded",
      sourceId: documentId,
      payload: { title: "paper.pdf", fileType: "pdf", fileSizeBytes: 2048 },
    });

    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [documentId]);

    // The log is not rewritten by a cascade: having had the document remains
    // true, and the snapshotted title keeps the row interpretable.
    const { rows } = await db.sql.query<{ source_id: string; payload: { title: string } }>(
      `SELECT source_id, payload FROM public.observations WHERE user_id = $1`,
      [alice],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(documentId);
    expect(rows[0].payload.title).toBe("paper.pdf");
  });

  it("finds every observation attached to one source", async () => {
    const chunkSource = "66666666-6666-4666-8666-666666666666";
    await insertObservation(alice, {
      eventType: "evidence_cited",
      sourceId: chunkSource,
      payload: {
        citationIndex: 1,
        documentId: null,
        documentTitle: "paper.pdf",
        pageStart: 2,
        pageEnd: 2,
        similarity: 0.8,
        conceptIds: [],
        conceptKeys: [],
      },
    });
    await insertObservation(alice);

    const { rows } = await db.sql.query(
      `SELECT id FROM public.observations
       WHERE user_id = $1 AND source_type = 'document_chunk' AND source_id = $2`,
      [alice, chunkSource],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("observations isolation and append-only enforcement", () => {
  it("never shows one user another user's history", async () => {
    await insertObservation(alice);
    await insertObservation(bob);

    const aliceRows = await db.asUser(alice, async () =>
      (await db.sql.query<{ user_id: string }>(`SELECT user_id FROM public.observations`)).rows,
    );
    const bobRows = await db.asUser(bob, async () =>
      (await db.sql.query<{ user_id: string }>(`SELECT user_id FROM public.observations`)).rows,
    );

    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].user_id).toBe(alice);
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0].user_id).toBe(bob);
  });

  it("blocks writing an observation attributed to another user", async () => {
    await expect(
      db.asUser(bob, () =>
        db.sql.query(
          `INSERT INTO public.observations
             (user_id, event_type, event_category, actor, source_type, payload)
           VALUES ($1,'search_performed','retrieval','user','system','{}'::jsonb)`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("blocks deleting another user's history", async () => {
    await insertObservation(alice);
    await db.asUser(bob, () => db.sql.query(`DELETE FROM public.observations`));

    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations`,
    );
    expect(rows[0].count).toBe("1");
  });

  it("allows a user to erase their own history", async () => {
    await insertObservation(alice);
    await db.asUser(alice, () => db.sql.query(`DELETE FROM public.observations`));

    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations`,
    );
    expect(rows[0].count).toBe("0");
  });

  it("removes a user's history when the account is deleted", async () => {
    await insertObservation(alice);
    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    const { rows } = await db.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.observations WHERE user_id = $1`,
      [alice],
    );
    expect(rows[0].count).toBe("0");
  });

  it("refuses to rewrite history, through two independent layers", async () => {
    const id = await insertObservation(alice, {
      payload: { query: "original", resultCount: 1, topSimilarity: 0.5 },
    });

    // Layer 1: there is no UPDATE policy, so the row is not even visible to an
    // UPDATE by its owner. No error, no rows touched.
    const asOwner = await db.asUser(alice, () =>
      db.sql.query(`UPDATE public.observations SET payload = '{}'::jsonb WHERE id = $1`, [id]),
    );
    expect(asOwner.affectedRows).toBe(0);

    // Layer 2: the service role bypasses RLS entirely, so the trigger is what
    // actually stops it.
    await expect(
      db.asServiceRole(() =>
        db.sql.query(`UPDATE public.observations SET event_type = 'question_asked' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/append-only/);

    const { rows } = await db.sql.query<{ payload: { query: string }; event_type: string }>(
      `SELECT payload, event_type FROM public.observations WHERE id = $1`,
      [id],
    );
    expect(rows[0].payload.query).toBe("original");
    expect(rows[0].event_type).toBe("search_performed");
  });
});
