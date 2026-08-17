/**
 * Knowledge states: a derived projection over the observation log.
 *
 * The central property is purity — discarding the table and rebuilding must
 * reproduce byte-identical state. Everything else here checks that the counts
 * and timestamps mean what they claim, and that no scoring or judgement has
 * crept in.
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
    DELETE FROM public.knowledge_states;
    DELETE FROM public.concept_mentions;
    DELETE FROM public.concept_edges;
    DELETE FROM public.concepts;
    DELETE FROM public.observations;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
    DELETE FROM public.messages;
    DELETE FROM public.conversations;
  `);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

const CHUNK_TEXT = "Working memory capacity predicts reading comprehension in ADHD participants.";

async function seedDocument(userId: string, title: string, createdAt: string, chunkCount = 1) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path, created_at)
       VALUES ($1,$2,'pdf','ready',$3,$4) RETURNING id`,
      [userId, title, `${userId}/${title}`, createdAt],
    )
  ).rows[0].id;

  const chunkIds: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const { rows } = await db.sql.query<{ id: string }>(
      `INSERT INTO public.document_chunks (document_id, chunk_index, content, page_start, page_end)
       VALUES ($1,$2,$3,1,1) RETURNING id`,
      [documentId, index, CHUNK_TEXT],
    );
    chunkIds.push(rows[0].id);
  }
  return { documentId, chunkIds };
}

type Candidate = {
  label: string;
  canonicalKey: string;
  mentions: Array<{ chunkId: string; surfaceForm: string; charStart: number; charEnd: number }>;
};

function candidate(label: string, key: string, chunkIds: string[], surfaceForm = "Working memory"): Candidate {
  const charStart = CHUNK_TEXT.indexOf(surfaceForm);
  return {
    label,
    canonicalKey: key,
    mentions: chunkIds.map((chunkId) => ({
      chunkId,
      surfaceForm,
      charStart,
      charEnd: charStart + surfaceForm.length,
    })),
  };
}

async function syncConcepts(userId: string, documentId: string, candidates: Candidate[]) {
  const { rows } = await db.sql.query<{ result: Record<string, number> }>(
    `SELECT public.sync_document_concepts($1,$2,$3::jsonb,0.95) AS result`,
    [userId, documentId, JSON.stringify(candidates)],
  );
  return rows[0].result;
}

/**
 * Records an `evidence_cited` observation the way the ask route does.
 *
 * `attributed: false` reproduces a citation written before concept attribution
 * existed, which must still resolve through the chunk join.
 */
async function citeChunk(
  userId: string,
  chunkId: string,
  messageId: string,
  occurredAt: string,
  citationIndex = 1,
  { attributed = false }: { attributed?: boolean } = {},
) {
  let payload = `jsonb_build_object('citationIndex',$5::int)`;
  if (attributed) {
    // Mirrors `attachConceptAttribution`: the concepts the passage carried,
    // snapshotted while the mentions still exist.
    payload = `(
      SELECT jsonb_build_object(
        'citationIndex', $5::int,
        'conceptIds', COALESCE(jsonb_agg(DISTINCT m.concept_id::text), '[]'::jsonb),
        'conceptKeys', COALESCE(jsonb_agg(DISTINCT c.canonical_key), '[]'::jsonb))
      FROM public.concept_mentions m
      JOIN public.concepts c ON c.id = m.concept_id
      WHERE m.chunk_id = $2
    )`;
  }

  await db.sql.query(
    `INSERT INTO public.observations
       (user_id, event_type, event_category, actor, source_type, source_id,
        occurred_at, context, payload, dedupe_key)
     VALUES ($1,'evidence_cited','interaction','cortex','document_chunk',$2,$3,
             jsonb_build_object('messageId',$4::text),
             ${payload},
             'evidence_cited:' || $4 || ':' || $5::text)`,
    [userId, chunkId, occurredAt, messageId, citationIndex],
  );
}

const rebuild = (userId: string) =>
  db.sql.query(`SELECT public.rebuild_knowledge_states($1)`, [userId]);

const stateFor = async (label: string) =>
  (
    await db.sql.query<{
      encounter_count: number;
      encounter_document_count: number;
      first_encountered_at: Date | null;
      last_encountered_at: Date | null;
      retrieval_count: number;
      retrieval_answer_count: number;
      first_retrieved_at: Date | null;
      last_retrieved_at: Date | null;
    }>(
      `SELECT k.* FROM public.knowledge_states k
       JOIN public.concepts c ON c.id = k.concept_id
       WHERE c.canonical_key = $1`,
      [label],
    )
  ).rows[0];

/** Full projection snapshot, ordered deterministically for comparison. */
const snapshot = async () =>
  (
    await db.sql.query(
      `SELECT user_id, concept_id, encounter_count, encounter_document_count,
              first_encountered_at, last_encountered_at, retrieval_count,
              retrieval_answer_count, first_retrieved_at, last_retrieved_at,
              derived_through_observation_id
       FROM public.knowledge_states
       ORDER BY user_id, concept_id`,
    )
  ).rows;

// ---------------------------------------------------------------------------

describe("purity: the projection is a pure function of the log", () => {
  it("reproduces byte-identical state after TRUNCATE and rebuild", async () => {
    const first = await seedDocument(alice, "one.pdf", "2026-01-10T00:00:00.000Z", 2);
    const second = await seedDocument(alice, "two.pdf", "2026-03-20T00:00:00.000Z");

    await syncConcepts(alice, first.documentId, [
      candidate("working memory", "working memory", first.chunkIds),
      candidate("attention deficit hyperactivity disorder", "adhd", [first.chunkIds[0]], "ADHD"),
    ]);
    await syncConcepts(alice, second.documentId, [
      candidate("working memory", "working memory", second.chunkIds),
    ]);

    const conversationId = (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.conversations (user_id, title) VALUES ($1,'c') RETURNING id`,
        [alice],
      )
    ).rows[0].id;
    const messageId = (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.messages (conversation_id, role, content)
         VALUES ($1,'assistant','answer') RETURNING id`,
        [conversationId],
      )
    ).rows[0].id;

    await citeChunk(alice, first.chunkIds[0], messageId, "2026-04-01T00:00:00.000Z", 1);
    await citeChunk(alice, second.chunkIds[0], messageId, "2026-04-01T00:00:00.000Z", 2);
    await rebuild(alice);

    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);

    // The acceptance test. If any column were independently mutated rather than
    // derived, it could not survive this.
    await db.sql.exec(`TRUNCATE public.knowledge_states;`);
    expect(await snapshot()).toHaveLength(0);
    await rebuild(alice);

    expect(await snapshot()).toEqual(before);
  });

  it("is unchanged by rebuilding repeatedly", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    await rebuild(alice);
    const once = await snapshot();
    await rebuild(alice);
    await rebuild(alice);
    expect(await snapshot()).toEqual(once);
  });

  it("has no write path outside the rebuild", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    // A projection a client can edit is no longer a projection.
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`UPDATE public.knowledge_states SET encounter_count = 99`),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
    const conceptId = (
      await db.sql.query<{ id: string }>(`SELECT id FROM public.concepts`)
    ).rows[0].id;
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`INSERT INTO public.knowledge_states (user_id, concept_id) VALUES ($1,$2)`, [
          alice,
          conceptId,
        ]),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("is refreshed automatically whenever concepts change", async () => {
    // `sync_document_concepts` -> `rebuild_concept_projections` -> here, so the
    // projection is never stale with respect to the concept graph.
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    expect(await stateFor("working memory")).toBeDefined();
    expect((await stateFor("working memory")).encounter_count).toBe(1);
  });
});

describe("encounter counts", () => {
  it("counts one encounter per concept per document", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z", 3);
    // Three mentions across three chunks of one document is still one encounter.
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    const state = await stateFor("working memory");
    expect(state.encounter_count).toBe(1);
    expect(state.encounter_document_count).toBe(1);
  });

  it("accumulates across documents and keeps the true first and last dates", async () => {
    const older = await seedDocument(alice, "old.pdf", "2026-01-05T00:00:00.000Z");
    const newer = await seedDocument(alice, "new.pdf", "2026-09-15T00:00:00.000Z");

    await syncConcepts(alice, newer.documentId, [
      candidate("working memory", "working memory", newer.chunkIds),
    ]);
    await syncConcepts(alice, older.documentId, [
      candidate("working memory", "working memory", older.chunkIds),
    ]);

    const state = await stateFor("working memory");
    expect(state.encounter_count).toBe(2);
    expect(state.encounter_document_count).toBe(2);
    // Dates come from when the user added the material, not from processing order.
    expect(new Date(state.first_encountered_at!).toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(new Date(state.last_encountered_at!).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("does not double count when a document is reprocessed", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const candidates = [candidate("working memory", "working memory", chunkIds)];

    await syncConcepts(alice, documentId, candidates);
    await syncConcepts(alice, documentId, candidates);
    await syncConcepts(alice, documentId, candidates);

    expect((await stateFor("working memory")).encounter_count).toBe(1);
  });

  it("survives a concept being pruned and met again", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const candidates = [candidate("working memory", "working memory", chunkIds)];

    await syncConcepts(alice, documentId, candidates);
    await syncConcepts(alice, documentId, []);
    await syncConcepts(alice, documentId, candidates);

    // The concept row was recreated with a new id; joining on canonical key is
    // what keeps the encounter attached to the same idea.
    expect((await stateFor("working memory")).encounter_count).toBe(1);
  });

  it("reports zero rather than vanishing when the evidencing observation is erased", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    await db.sql.query(`DELETE FROM public.observations WHERE event_type = 'concept_encountered'`);
    await rebuild(alice);

    const state = await stateFor("working memory");
    expect(state.encounter_count).toBe(0);
    expect(state.first_encountered_at).toBeNull();
  });
});

describe("retrieval counts", () => {
  async function seedAnswer(userId: string) {
    const conversationId = (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.conversations (user_id, title) VALUES ($1,'c') RETURNING id`,
        [userId],
      )
    ).rows[0].id;
    return (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.messages (conversation_id, role, content)
         VALUES ($1,'assistant','answer') RETURNING id`,
        [conversationId],
      )
    ).rows[0].id;
  }

  it("counts a citation of a chunk that mentions the concept", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z");
    await rebuild(alice);

    const state = await stateFor("working memory");
    expect(state.retrieval_count).toBe(1);
    expect(state.retrieval_answer_count).toBe(1);
    expect(new Date(state.first_retrieved_at!).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("counts one answer citing several passages of the same idea once as an answer", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z", 3);
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    const messageId = await seedAnswer(alice);
    for (const [index, chunkId] of chunkIds.entries()) {
      await citeChunk(alice, chunkId, messageId, "2026-02-01T00:00:00.000Z", index + 1);
    }
    await rebuild(alice);

    const state = await stateFor("working memory");
    expect(state.retrieval_count).toBe(3);
    expect(state.retrieval_answer_count).toBe(1);
  });

  it("counts a citation once even when a chunk mentions the concept repeatedly", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const twice = CHUNK_TEXT.indexOf("Working memory");
    await syncConcepts(alice, documentId, [
      {
        label: "working memory",
        canonicalKey: "working memory",
        mentions: [
          { chunkId: chunkIds[0], surfaceForm: "Working memory", charStart: twice, charEnd: twice + 14 },
          { chunkId: chunkIds[0], surfaceForm: "memory", charStart: CHUNK_TEXT.indexOf("memory"), charEnd: CHUNK_TEXT.indexOf("memory") + 6 },
        ],
      },
    ]);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z");
    await rebuild(alice);

    // Two mentions, one citation: one retrieval.
    expect((await stateFor("working memory")).retrieval_count).toBe(1);
  });

  it("leaves a never-cited concept at zero", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);
    await rebuild(alice);

    const state = await stateFor("working memory");
    expect(state.retrieval_count).toBe(0);
    expect(state.last_retrieved_at).toBeNull();
  });

  it("keeps an attributed citation resolvable after its document is deleted", async () => {
    // The gap closed in Part 0. A citation written with concept attribution
    // survives the deletion of the document it came from, because the concepts
    // it carried were snapshotted at citation time.
    const source = await seedDocument(alice, "source.pdf", "2026-01-01T00:00:00.000Z");
    const keeper = await seedDocument(alice, "keeper.pdf", "2026-01-02T00:00:00.000Z");
    await syncConcepts(alice, source.documentId, [
      candidate("working memory", "working memory", source.chunkIds),
    ]);
    await syncConcepts(alice, keeper.documentId, [
      candidate("working memory", "working memory", keeper.chunkIds),
    ]);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, source.chunkIds[0], messageId, "2026-02-01T00:00:00.000Z", 1, {
      attributed: true,
    });
    await rebuild(alice);
    expect((await stateFor("working memory")).retrieval_count).toBe(1);

    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [source.documentId]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));

    // The chunk and its mentions are gone, so the old join path cannot resolve
    // this. The payload snapshot still does.
    expect(await countRows("concept_mentions", "chunk_id = $1", [source.chunkIds[0]])).toBe(0);
    const state = await stateFor("working memory");
    expect(state.retrieval_count).toBe(1);
    expect(new Date(state.last_retrieved_at!).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("resolves an attributed citation through the concept's durable key", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const candidates = [candidate("working memory", "working memory", chunkIds)];
    await syncConcepts(alice, documentId, candidates);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z", 1, {
      attributed: true,
    });

    // Prune and recreate the concept: the stored concept id is now dead, but the
    // canonical key still identifies the same idea.
    await syncConcepts(alice, documentId, []);
    await syncConcepts(alice, documentId, candidates);
    await rebuild(alice);

    expect((await stateFor("working memory")).retrieval_count).toBe(1);
  });

  it("counts an attributed citation exactly once", async () => {
    // Both the id list and the key list resolve to the same concept; UNION in
    // the rebuild must not turn that into two retrievals.
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z", 1, {
      attributed: true,
    });
    await rebuild(alice);

    const state = await stateFor("working memory");
    expect(state.retrieval_count).toBe(1);
    expect(state.retrieval_answer_count).toBe(1);
  });

  it("still resolves an unattributed citation through the chunk join", async () => {
    // Observations written before Part 0 keep their weaker resolution path.
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);

    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z");
    await rebuild(alice);

    expect((await stateFor("working memory")).retrieval_count).toBe(1);
  });

  it("cannot reconstruct retrievals for a deleted document (accepted limitation)", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);
    const messageId = await seedAnswer(alice);
    await citeChunk(alice, chunkIds[0], messageId, "2026-02-01T00:00:00.000Z");
    await rebuild(alice);
    expect((await stateFor("working memory")).retrieval_count).toBe(1);

    // The chunk->concept link lives in `concept_mentions`, which cascades with
    // the document. The `evidence_cited` observation survives but can no longer
    // be attributed. Documented as an M5 consideration, pinned here so the
    // limitation is visible rather than surprising.
    const second = await seedDocument(alice, "b.pdf", "2026-03-01T00:00:00.000Z");
    await syncConcepts(alice, second.documentId, [
      candidate("working memory", "working memory", second.chunkIds),
    ]);
    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [documentId]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));

    expect(await countRows("observations", "event_type = 'evidence_cited'")).toBe(1);
    expect((await stateFor("working memory")).retrieval_count).toBe(0);
  });
});

const countRows = async (table: string, where = "TRUE", params: unknown[] = []) =>
  Number(
    (
      await db.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${table} WHERE ${where}`,
        params,
      )
    ).rows[0].count,
  );

describe("scope boundary", () => {
  it("stores no mastery, confidence, or decay column", async () => {
    const { rows } = await db.sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_states'`,
    );
    const names = rows.map((row) => row.column_name);
    const forbidden = /(mastery|confidence|score|strength|familiar|decay|half_life|retention|forget|proficien|level)/i;
    for (const name of names) {
      expect(name).not.toMatch(forbidden);
    }
    // Only counts, timestamps, keys, and the watermark.
    expect(names.sort()).toEqual(
      [
        "concept_id",
        "derived_through_observation_id",
        "encounter_count",
        "encounter_document_count",
        "first_encountered_at",
        "first_retrieved_at",
        "last_encountered_at",
        "last_retrieved_at",
        "retrieval_answer_count",
        "retrieval_count",
        "user_id",
      ].sort(),
    );
  });

  it("carries no bookkeeping clock that would make purity untestable", async () => {
    const { rows } = await db.sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='knowledge_states'`,
    );
    // A `rebuilt_at` would change on every rebuild and defeat the comparison.
    expect(rows.map((row) => row.column_name)).not.toContain("rebuilt_at");
  });
});

describe("isolation", () => {
  it("never mixes one user's counts into another's", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const bobDoc = await seedDocument(bob, "b.pdf", "2026-01-01T00:00:00.000Z");

    await syncConcepts(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkIds),
    ]);
    await syncConcepts(bob, bobDoc.documentId, [
      candidate("working memory", "working memory", bobDoc.chunkIds),
    ]);

    const perUser = await db.sql.query<{ user_id: string; count: string }>(
      `SELECT user_id, count(*)::text AS count FROM public.knowledge_states GROUP BY user_id`,
    );
    expect(perUser.rows).toHaveLength(2);
    for (const row of perUser.rows) expect(row.count).toBe("1");

    const { rows } = await db.sql.query<{ encounter_count: number }>(
      `SELECT k.encounter_count FROM public.knowledge_states k WHERE k.user_id = $1`,
      [alice],
    );
    expect(rows[0].encounter_count).toBe(1);
  });

  it("never shows one user another's projection", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkIds),
    ]);

    const visible = await db.asUser(bob, async () =>
      (await db.sql.query(`SELECT concept_id FROM public.knowledge_states`)).rows,
    );
    expect(visible).toHaveLength(0);

    const own = await db.asUser(alice, async () =>
      (await db.sql.query(`SELECT concept_id FROM public.knowledge_states`)).rows,
    );
    expect(own).toHaveLength(1);
  });

  it("rebuilds only the caller's own projection", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const bobDoc = await seedDocument(bob, "b.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkIds),
    ]);
    await syncConcepts(bob, bobDoc.documentId, [
      candidate("working memory", "working memory", bobDoc.chunkIds),
    ]);

    await db.asUser(alice, () => db.sql.query(`SELECT public.refresh_my_knowledge_states()`));
    expect(await countRows("knowledge_states", "user_id = $1", [bob])).toBe(1);
  });

  it("keeps the direct rebuild out of reach of ordinary users", async () => {
    await expect(
      db.asUser(alice, () => db.sql.query(`SELECT public.rebuild_knowledge_states($1)`, [bob])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("does nothing for an unauthenticated refresh", async () => {
    // No `auth.uid()` means no caller to refresh, so the guard returns 0 rather
    // than silently rebuilding somebody's projection.
    const rows = await db.asServiceRole(async () =>
      (await db.sql.query<{ r: number }>(`SELECT public.refresh_my_knowledge_states() AS r`)).rows,
    );
    expect(rows[0].r).toBe(0);
  });

  it("removes the projection with the account", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkIds),
    ]);

    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    expect(await countRows("knowledge_states")).toBe(0);
  });

  it("drops a concept's state when the concept is pruned", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await syncConcepts(alice, documentId, [candidate("working memory", "working memory", chunkIds)]);
    expect(await countRows("knowledge_states")).toBe(1);

    await syncConcepts(alice, documentId, []);
    expect(await countRows("knowledge_states")).toBe(0);
  });
});
