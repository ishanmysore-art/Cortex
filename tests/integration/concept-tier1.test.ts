/**
 * Regression tests for the three Tier 1 defects in the Milestone 2 concept layer.
 *
 * Each `describe` below reproduces the original failure directly: the assertions
 * would have failed against the pre-correction schema, not merely covered new
 * behaviour.
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
  await db.sql.exec(`
    DELETE FROM public.observations;
    DELETE FROM public.concept_mentions;
    DELETE FROM public.concept_edges;
    DELETE FROM public.concepts;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
  `);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

function embedding(seed: number, tilt = 0): number[] {
  const values = new Array<number>(1536).fill(0);
  values[seed % 1536] = 1;
  if (tilt !== 0) values[(seed + 1) % 1536] = tilt;
  return values;
}

const CHUNK_TEXT = "Working memory capacity predicts reading comprehension in ADHD participants.";

/** Seeds a document whose `created_at` is the user's encounter time. */
async function seedDocument(userId: string, title: string, createdAt: string) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path, created_at)
       VALUES ($1,$2,'pdf','ready',$3,$4) RETURNING id`,
      [userId, title, `${userId}/${title}`, createdAt],
    )
  ).rows[0].id;

  const chunkId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.document_chunks (document_id, chunk_index, content, page_start, page_end)
       VALUES ($1,0,$2,1,1) RETURNING id`,
      [documentId, CHUNK_TEXT],
    )
  ).rows[0].id;

  return { documentId, chunkId };
}

type Candidate = {
  label: string;
  canonicalKey: string;
  embedding?: number[];
  mentions: Array<{ chunkId: string; surfaceForm: string; charStart: number; charEnd: number }>;
};

function candidate(
  label: string,
  key: string,
  chunkId: string,
  surfaceForm: string,
  embeddingVector?: number[],
): Candidate {
  const charStart = CHUNK_TEXT.indexOf(surfaceForm);
  if (charStart === -1) throw new Error(`Test setup error: "${surfaceForm}" not in chunk.`);
  return {
    label,
    canonicalKey: key,
    embedding: embeddingVector,
    mentions: [{ chunkId, surfaceForm, charStart, charEnd: charStart + surfaceForm.length }],
  };
}

async function sync(userId: string, documentId: string, candidates: Candidate[], threshold = 0.95) {
  const { rows } = await db.sql.query<{ result: Record<string, number> }>(
    `SELECT public.sync_document_concepts($1,$2,$3::jsonb,$4) AS result`,
    [userId, documentId, JSON.stringify(candidates), threshold],
  );
  return rows[0].result;
}

const conceptRow = async (key = "working memory") =>
  (
    await db.sql.query<{
      id: string;
      first_seen_at: Date;
      last_seen_at: Date;
      embedding: string | null;
      embedding_model: string | null;
    }>(
      `SELECT id, first_seen_at, last_seen_at, embedding, embedding_model
       FROM public.concepts WHERE canonical_key = $1`,
      [key],
    )
  ).rows[0];

// ---------------------------------------------------------------------------

describe("Tier 1 #1 — encounter time survives reprocessing", () => {
  const ENCOUNTERED = "2026-01-15T09:00:00.000Z";

  it("anchors both clocks to when the user added the document", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    const concept = await conceptRow();
    // Previously these were MIN/MAX of the mention row's write time, i.e. now().
    expect(new Date(concept.first_seen_at).toISOString()).toBe(ENCOUNTERED);
    expect(new Date(concept.last_seen_at).toISOString()).toBe(ENCOUNTERED);
  });

  it("does not move last_seen_at when the document is reprocessed", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    const candidates = [candidate("working memory", "working memory", chunkId, "Working memory")];

    await sync(alice, documentId, candidates);
    const before = await conceptRow();

    // The exact original failure: re-ingest replaced every mention, so
    // MAX(created_at) became now() and "last encountered" silently became
    // "last reprocessed".
    await sync(alice, documentId, candidates);
    await sync(alice, documentId, candidates);
    const after = await conceptRow();

    expect(new Date(after.last_seen_at).toISOString()).toBe(ENCOUNTERED);
    expect(after.last_seen_at).toEqual(before.last_seen_at);
    expect(after.first_seen_at).toEqual(before.first_seen_at);
  });

  it("survives a bulk re-ingest of the whole corpus", async () => {
    const older = await seedDocument(alice, "old.pdf", "2026-01-01T00:00:00.000Z");
    const newer = await seedDocument(alice, "new.pdf", "2026-06-01T00:00:00.000Z");

    const olderCandidates = [
      candidate("working memory", "working memory", older.chunkId, "Working memory"),
    ];
    const newerCandidates = [
      candidate("working memory", "working memory", newer.chunkId, "Working memory"),
    ];

    await sync(alice, older.documentId, olderCandidates);
    await sync(alice, newer.documentId, newerCandidates);

    // scripts/reingest-all.ts re-processes every document. This used to flatten
    // every concept's history to a single moment.
    await sync(alice, older.documentId, olderCandidates);
    await sync(alice, newer.documentId, newerCandidates);

    const concept = await conceptRow();
    expect(new Date(concept.first_seen_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(concept.last_seen_at).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("spans the range between the earliest and latest encounter", async () => {
    const older = await seedDocument(alice, "old.pdf", "2026-02-01T00:00:00.000Z");
    const newer = await seedDocument(alice, "new.pdf", "2026-08-01T00:00:00.000Z");

    await sync(alice, newer.documentId, [
      candidate("working memory", "working memory", newer.chunkId, "Working memory"),
    ]);
    await sync(alice, older.documentId, [
      candidate("working memory", "working memory", older.chunkId, "Working memory"),
    ]);

    const concept = await conceptRow();
    // Order of processing must not affect the answer.
    expect(new Date(concept.first_seen_at).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(new Date(concept.last_seen_at).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps the write clock separate from the encounter clock", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    const { rows } = await db.sql.query<{ encountered_at: Date; created_at: Date }>(
      `SELECT encountered_at, created_at FROM public.concept_mentions`,
    );
    expect(new Date(rows[0].encountered_at).toISOString()).toBe(ENCOUNTERED);
    // created_at remains an audit clock, and the two must not be conflated.
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(
      new Date(rows[0].encountered_at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------

describe("Tier 1 #2 — concept encounters are immutable evidence", () => {
  const ENCOUNTERED = "2026-03-10T12:00:00.000Z";

  const encounters = async (userId?: string) =>
    (
      await db.sql.query<{
        id: string;
        source_type: string;
        source_id: string;
        occurred_at: Date;
        payload: { canonicalKey: string; documentTitle: string; mentionCount: number };
        context: { documentId: string };
        actor: string;
        event_category: string;
      }>(
        `SELECT id, source_type, source_id, occurred_at, payload, context, actor, event_category
         FROM public.observations
         WHERE event_type = 'concept_encountered'
           AND ($1::uuid IS NULL OR user_id = $1)
         ORDER BY payload->>'canonicalKey'`,
        [userId ?? null],
      )
    ).rows;

  it("records one encounter per concept per document", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    const summary = await sync(alice, documentId, [
      candidate("working memory", "working memory", chunkId, "Working memory"),
      candidate("attention deficit hyperactivity disorder", "adhd", chunkId, "ADHD"),
    ]);

    expect(summary.encountersRecorded).toBe(2);
    const rows = await encounters();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload.canonicalKey)).toEqual(["adhd", "working memory"]);
  });

  it("timestamps the encounter, not the extraction run", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    const [row] = await encounters();
    expect(new Date(row.occurred_at).toISOString()).toBe(ENCOUNTERED);
  });

  it("points at the concept and carries its durable identity", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    const concept = await conceptRow();
    const [row] = await encounters();

    // source_id is the live join target for a future claim_evidence row...
    expect(row.source_type).toBe("concept");
    expect(row.source_id).toBe(concept.id);
    // ...and canonicalKey is the identity that survives a prune/recreate cycle.
    expect(row.payload.canonicalKey).toBe("working memory");
    expect(row.payload.documentTitle).toBe("paper.pdf");
    expect(row.payload.mentionCount).toBe(1);
    expect(row.context.documentId).toBe(documentId);
  });

  it("is idempotent across reprocessing", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    const candidates = [candidate("working memory", "working memory", chunkId, "Working memory")];

    await sync(alice, documentId, candidates);
    const second = await sync(alice, documentId, candidates);
    await sync(alice, documentId, candidates);

    expect(second.encountersRecorded).toBe(0);
    expect(await encounters()).toHaveLength(1);
  });

  it("does not double-record when a concept is pruned and met again", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    const candidates = [candidate("working memory", "working memory", chunkId, "Working memory")];

    await sync(alice, documentId, candidates);
    // Extraction misses it, the concept is pruned, then a later run finds it.
    await sync(alice, documentId, []);
    expect(await db.sql.query(`SELECT id FROM public.concepts`).then((r) => r.rows)).toHaveLength(0);
    await sync(alice, documentId, candidates);

    // Keying on the concept id would have emitted a second encounter here for
    // material the user met once.
    expect(await encounters()).toHaveLength(1);
  });

  it("outlives the document and the concept it describes", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [documentId]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));

    // The derived graph is gone; the evidence that the user met the idea is not.
    expect(await db.sql.query(`SELECT id FROM public.concepts`).then((r) => r.rows)).toHaveLength(0);
    const rows = await encounters();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.canonicalKey).toBe("working memory");
    expect(new Date(rows[0].occurred_at).toISOString()).toBe(ENCOUNTERED);
  });

  it("stays append-only and user-scoped like every other observation", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", ENCOUNTERED);
    await sync(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkId, "Working memory"),
    ]);

    const visibleToBob = await db.asUser(bob, async () =>
      (
        await db.sql.query(
          `SELECT id FROM public.observations WHERE event_type = 'concept_encountered'`,
        )
      ).rows,
    );
    expect(visibleToBob).toHaveLength(0);

    const [row] = await encounters();
    await expect(
      db.asServiceRole(() =>
        db.sql.query(`UPDATE public.observations SET payload = '{}'::jsonb WHERE id = $1`, [row.id]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("matches the row shape the application recorder would produce", async () => {
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate("working memory", "working memory", chunkId, "Working memory")]);

    const [row] = await encounters();
    // The event is written in SQL for atomicity, so this pins it to the
    // TypeScript taxonomy that owns the vocabulary.
    const expected = buildObservationRow({
      userId: alice,
      eventType: "concept_encountered",
      sourceId: row.source_id,
      payload: {
        label: "working memory",
        canonicalKey: "working memory",
        documentTitle: "paper.pdf",
        mentionCount: 1,
      },
    });

    expect(row.event_category).toBe(expected.event_category);
    expect(row.actor).toBe(expected.actor);
    expect(row.source_type).toBe(expected.source_type);
  });

  it("keeps the dedupe key inside the column's limit for a maximal concept", async () => {
    const longKey = "a".repeat(120);
    const { documentId, chunkId } = await seedDocument(alice, "paper.pdf", ENCOUNTERED);
    await sync(alice, documentId, [candidate(longKey, longKey, chunkId, "Working memory")]);

    const { rows } = await db.sql.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM public.observations WHERE event_type = 'concept_encountered'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------

/**
 * Note on severity. Measured with `EXPLAIN`, the original HNSW index was never
 * actually chosen for this query: the planner filters on `user_id` first and
 * sorts the small remainder. The defect was therefore LATENT — a planner cliff
 * that would appear once a single user's concept count made an index-ordered
 * scan look cheaper, at which point post-filtering by `user_id` would start
 * discarding the true neighbour and silently manufacture duplicates.
 *
 * These tests consequently pin the *guarantee* (no approximate index can be
 * chosen) rather than reproducing a failure that the planner never triggered at
 * any scale reachable in a test. The behavioural test below is a correctness
 * guard; it passed before the fix too, and it is documented as such rather than
 * dressed up as a reproduction.
 */
describe("Tier 1 #3 — deduplication cannot be defeated by other tenants", () => {
  it("has no approximate index the planner could ever choose", async () => {
    const { rows } = await db.sql.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'concepts'`,
    );
    const ann = rows.filter((row) => /USING (hnsw|ivfflat)/i.test(row.indexdef));
    // This is the actual fix: with no ANN index present, no future planner
    // decision can substitute an approximate scan for an exact one.
    expect(ann).toEqual([]);
  });

  it("keeps the tenant-scoped lookup exact, whichever plan is chosen", async () => {
    // Every foreign concept is placed nearer to the probe than Alice's own, so
    // an approximate top-k would be entirely Bob's and would filter to nothing.
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await sync(alice, aliceDoc.documentId, [
      candidate("working memory", "working memory", aliceDoc.chunkId, "Working memory", embedding(5)),
    ]);

    const probe = embedding(5, 0.2); // ~0.98 similar to Alice's concept
    for (let index = 0; index < 300; index += 1) {
      await db.sql.query(
        `INSERT INTO public.concepts (user_id, label, canonical_key, embedding)
         VALUES ($1, $2, $2, $3::vector)`,
        [bob, `foreign concept ${index}`, JSON.stringify(probe)],
      );
    }

    const second = await seedDocument(alice, "b.pdf", "2026-02-01T00:00:00.000Z");
    const summary = await sync(alice, second.documentId, [
      candidate("working memory span", "working memory span", second.chunkId, "Working memory", probe),
    ]);

    expect(summary.conceptsMatchedSemantic).toBe(1);
    expect(summary.conceptsCreated).toBe(0);

    const aliceConcepts = await db.sql.query(
      `SELECT id FROM public.concepts WHERE user_id = $1`,
      [alice],
    );
    expect(aliceConcepts.rows).toHaveLength(1);
  });

  it("never resolves one user's concept against another's", async () => {
    const bobDoc = await seedDocument(bob, "b.pdf", "2026-01-01T00:00:00.000Z");
    await sync(bob, bobDoc.documentId, [
      candidate("working memory", "working memory", bobDoc.chunkId, "Working memory", embedding(5)),
    ]);

    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const summary = await sync(alice, aliceDoc.documentId, [
      candidate("working memory span", "working memory span", aliceDoc.chunkId, "Working memory", embedding(5, 0.2)),
    ]);

    expect(summary.conceptsMatchedSemantic).toBe(0);
    expect(summary.conceptsCreated).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("integrity fixes", () => {
  it("backfills an embedding onto a concept that was created without one", async () => {
    const first = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await sync(alice, first.documentId, [
      candidate("working memory", "working memory", first.chunkId, "Working memory"),
    ]);
    expect((await conceptRow()).embedding).toBeNull();

    const second = await seedDocument(alice, "b.pdf", "2026-02-01T00:00:00.000Z");
    const summary = await sync(alice, second.documentId, [
      candidate("working memory", "working memory", second.chunkId, "Working memory", embedding(5)),
    ]);

    // Without this the concept stays permanently invisible to deduplication and
    // to any later similarity query, with no way to identify affected rows.
    expect(summary.embeddingsBackfilled).toBe(1);
    const concept = await conceptRow();
    expect(concept.embedding).not.toBeNull();
    expect(concept.embedding_model).toBeNull();
  });

  it("does not overwrite an embedding a concept already has", async () => {
    const first = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    await sync(alice, first.documentId, [
      candidate("working memory", "working memory", first.chunkId, "Working memory", embedding(5)),
    ]);
    const original = (await conceptRow()).embedding;

    const second = await seedDocument(alice, "b.pdf", "2026-02-01T00:00:00.000Z");
    const summary = await sync(alice, second.documentId, [
      candidate("working memory", "working memory", second.chunkId, "Working memory", embedding(900)),
    ]);

    expect(summary.embeddingsBackfilled).toBe(0);
    expect((await conceptRow()).embedding).toBe(original);
  });

  it("refuses mentions pointing at a chunk of a different document", async () => {
    const target = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const other = await seedDocument(alice, "b.pdf", "2026-01-01T00:00:00.000Z");

    await expect(
      sync(alice, target.documentId, [
        candidate("working memory", "working memory", other.chunkId, "Working memory"),
      ]),
    ).rejects.toThrow(/chunk\(s\) outside document/);
  });

  it("refuses mentions pointing at another user's chunk", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", "2026-01-01T00:00:00.000Z");
    const bobDoc = await seedDocument(bob, "b.pdf", "2026-01-01T00:00:00.000Z");

    await expect(
      sync(alice, aliceDoc.documentId, [
        candidate("working memory", "working memory", bobDoc.chunkId, "Working memory"),
      ]),
    ).rejects.toThrow(/chunk\(s\) outside document/);

    // The rejection happens before any write, so nothing is left half-applied.
    expect(await db.sql.query(`SELECT id FROM public.concept_mentions`).then((r) => r.rows)).toHaveLength(0);
  });
});
