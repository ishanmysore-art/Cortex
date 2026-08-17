/**
 * Database-level tests for the concept layer, run against the real migration
 * files under an embedded Postgres.
 *
 * The properties under test are the ones that make the graph trustworthy:
 * every concept traces to a verifiable span, one idea is one row, edges only
 * ever report counted evidence, and no user can see another's graph.
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
    DELETE FROM public.concept_mentions;
    DELETE FROM public.concept_edges;
    DELETE FROM public.concepts;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
  `);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

/**
 * A unit vector with a single non-zero component, optionally tilted toward its
 * neighbour. Two different `seed`s are orthogonal (similarity 0); a `tilt` of
 * 0.2 gives similarity ~0.98, which straddles the 0.95 resolution threshold.
 */
function embedding(seed: number, tilt = 0): number[] {
  const values = new Array<number>(1536).fill(0);
  values[seed % 1536] = 1;
  if (tilt !== 0) values[(seed + 1) % 1536] = tilt;
  return values;
}

async function seedDocument(userId: string, title: string, chunkContents: string[]) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path)
       VALUES ($1,$2,'pdf','ready',$3) RETURNING id`,
      [userId, title, `${userId}/${title}`],
    )
  ).rows[0].id;

  const chunkIds: string[] = [];
  for (const [index, content] of chunkContents.entries()) {
    const { rows } = await db.sql.query<{ id: string }>(
      `INSERT INTO public.document_chunks (document_id, chunk_index, content, page_start, page_end)
       VALUES ($1,$2,$3,$4,$4) RETURNING id`,
      [documentId, index, content, index + 1],
    );
    chunkIds.push(rows[0].id);
  }
  return { documentId, chunkIds };
}

type CandidateInput = {
  label: string;
  canonicalKey: string;
  embedding?: number[];
  mentions: Array<{
    chunkId: string;
    surfaceForm: string;
    charStart: number;
    charEnd: number;
    pageStart?: number | null;
    pageEnd?: number | null;
  }>;
};

async function sync(
  userId: string,
  documentId: string,
  candidates: CandidateInput[],
  threshold = 0.95,
) {
  const { rows } = await db.sql.query<{ result: Record<string, number> }>(
    `SELECT public.sync_document_concepts($1,$2,$3::jsonb,$4) AS result`,
    [userId, documentId, JSON.stringify(candidates), threshold],
  );
  return rows[0].result;
}

/** Builds a candidate whose span is located the same way the extractor does. */
function candidateFor(
  label: string,
  canonicalKey: string,
  chunkId: string,
  content: string,
  surfaceForm: string,
  embeddingVector?: number[],
): CandidateInput {
  const charStart = content.indexOf(surfaceForm);
  if (charStart === -1) throw new Error(`Test setup error: "${surfaceForm}" is not in the chunk.`);
  return {
    label,
    canonicalKey,
    embedding: embeddingVector,
    mentions: [
      { chunkId, surfaceForm, charStart, charEnd: charStart + surfaceForm.length, pageStart: 1, pageEnd: 1 },
    ],
  };
}

const CHUNK_ONE = "Working memory capacity predicts reading comprehension in ADHD participants.";
const CHUNK_TWO = "The neural clock model explains temporal drift.";

const countRows = async (table: string, where = "TRUE", params: unknown[] = []) =>
  Number(
    (
      await db.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${table} WHERE ${where}`,
        params,
      )
    ).rows[0].count,
  );

describe("concept provenance", () => {
  it("anchors every mention to a span that matches the stored chunk text", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    // The invariant, checked in SQL against the text the mention points at.
    const { rows } = await db.sql.query<{ mismatches: string }>(
      `SELECT count(*)::text AS mismatches
       FROM public.concept_mentions m
       JOIN public.document_chunks c ON c.id = m.chunk_id
       WHERE substring(c.content FROM m.char_start + 1 FOR m.char_end - m.char_start) <> m.surface_form`,
    );
    expect(rows[0].mismatches).toBe("0");
    expect(await countRows("concept_mentions")).toBe(1);
  });

  it("keeps the surface form even when it differs from the canonical label", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor(
        "attention deficit hyperactivity disorder",
        "attention deficit hyperactivity disorder",
        chunkIds[0],
        CHUNK_ONE,
        "ADHD",
      ),
    ]);

    const { rows } = await db.sql.query<{ label: string; surface_form: string }>(
      `SELECT c.label, m.surface_form
       FROM public.concept_mentions m JOIN public.concepts c ON c.id = m.concept_id`,
    );
    // Canonicalisation is lossless: the page still says "ADHD".
    expect(rows[0].label).toBe("attention deficit hyperactivity disorder");
    expect(rows[0].surface_form).toBe("ADHD");
  });

  it("carries the chunk's page range onto the mention", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    const { rows } = await db.sql.query<{ page_start: number }>(
      `SELECT page_start FROM public.concept_mentions`,
    );
    expect(rows[0].page_start).toBe(1);
  });

  it("rejects a span that is not a real range", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await expect(
      sync(alice, documentId, [
        {
          label: "working memory",
          canonicalKey: "working memory",
          mentions: [{ chunkId: chunkIds[0], surfaceForm: "Working memory", charStart: 10, charEnd: 10 }],
        },
      ]),
    ).rejects.toThrow(/concept_mentions_span_valid/);
  });
});

describe("the hard rule: no concept without a mention", () => {
  it("prunes a concept whose last mention disappears on re-ingest", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    expect(await countRows("concepts")).toBe(1);

    // A re-ingest that no longer finds the concept.
    const summary = await sync(alice, documentId, []);
    expect(summary.prunedConcepts).toBe(1);
    expect(await countRows("concepts")).toBe(0);
  });

  it("prunes concepts orphaned by deleting the document", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [documentId]);
    // Mentions cascade with the document, but the concept row needs reconciling.
    expect(await countRows("concept_mentions")).toBe(0);
    expect(await countRows("concepts")).toBe(1);

    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));
    expect(await countRows("concepts")).toBe(0);
  });

  it("keeps a concept alive while another document still mentions it", async () => {
    const first = await seedDocument(alice, "one.pdf", [CHUNK_ONE]);
    const second = await seedDocument(alice, "two.pdf", [CHUNK_ONE]);

    await sync(alice, first.documentId, [
      candidateFor("working memory", "working memory", first.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    await sync(alice, second.documentId, [
      candidateFor("working memory", "working memory", second.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    await sync(alice, first.documentId, []);
    expect(await countRows("concepts")).toBe(1);
    const { rows } = await db.sql.query<{ mention_count: number; document_count: number }>(
      `SELECT mention_count, document_count FROM public.concepts`,
    );
    expect(rows[0]).toMatchObject({ mention_count: 1, document_count: 1 });
  });

  it("never leaves an orphan after any sync", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE, CHUNK_TWO]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("neural clock model", "neural clock model", chunkIds[1], CHUNK_TWO, "neural clock model"),
    ]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    const orphans = await countRows(
      "concepts c",
      "NOT EXISTS (SELECT 1 FROM public.concept_mentions m WHERE m.concept_id = c.id)",
    );
    expect(orphans).toBe(0);
  });
});

describe("deduplication", () => {
  it("resolves the same canonical key across documents to one concept", async () => {
    const first = await seedDocument(alice, "one.pdf", [CHUNK_ONE]);
    const second = await seedDocument(alice, "two.pdf", [CHUNK_ONE]);

    await sync(alice, first.documentId, [
      candidateFor("Working Memory", "working memory", first.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    const summary = await sync(alice, second.documentId, [
      candidateFor("working memory", "working memory", second.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    expect(summary.conceptsMatchedExact).toBe(1);
    expect(summary.conceptsCreated).toBe(0);
    expect(await countRows("concepts")).toBe(1);

    const { rows } = await db.sql.query<{ mention_count: number; document_count: number }>(
      `SELECT mention_count, document_count FROM public.concepts`,
    );
    expect(rows[0]).toMatchObject({ mention_count: 2, document_count: 2 });
  });

  it("keeps a concept's id stable across re-ingest", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    const candidate = candidateFor(
      "working memory",
      "working memory",
      chunkIds[0],
      CHUNK_ONE,
      "Working memory",
    );

    await sync(alice, documentId, [candidate]);
    const before = (await db.sql.query<{ id: string }>(`SELECT id FROM public.concepts`)).rows[0].id;
    await sync(alice, documentId, [candidate]);
    const after = (await db.sql.query<{ id: string }>(`SELECT id FROM public.concepts`)).rows[0].id;

    // Later layers will hold concept ids as foreign keys, so re-ingest must not
    // silently mint a new identity for the same idea.
    expect(after).toBe(before);
  });

  it("is idempotent: repeating a sync changes nothing", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    const candidates = [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ];

    await sync(alice, documentId, candidates);
    await sync(alice, documentId, candidates);
    await sync(alice, documentId, candidates);

    expect(await countRows("concepts")).toBe(1);
    expect(await countRows("concept_mentions")).toBe(1);
  });

  it("attaches a near-identical label to the existing concept instead of duplicating", async () => {
    const first = await seedDocument(alice, "one.pdf", [CHUNK_ONE]);
    const second = await seedDocument(alice, "two.pdf", [CHUNK_ONE]);

    await sync(alice, first.documentId, [
      candidateFor("working memory", "working memory", first.chunkIds[0], CHUNK_ONE, "Working memory", embedding(5)),
    ]);
    const summary = await sync(alice, second.documentId, [
      candidateFor(
        "working memory span",
        "working memory span",
        second.chunkIds[0],
        CHUNK_ONE,
        "Working memory",
        embedding(5, 0.2), // cosine ~0.98, above the 0.95 threshold
      ),
    ]);

    expect(summary.conceptsMatchedSemantic).toBe(1);
    expect(await countRows("concepts")).toBe(1);
  });

  it("does not merge concepts that are merely related", async () => {
    const first = await seedDocument(alice, "one.pdf", [CHUNK_ONE]);
    const second = await seedDocument(alice, "two.pdf", [CHUNK_TWO]);

    await sync(alice, first.documentId, [
      candidateFor("working memory", "working memory", first.chunkIds[0], CHUNK_ONE, "Working memory", embedding(5)),
    ]);
    const summary = await sync(alice, second.documentId, [
      candidateFor(
        "neural clock model",
        "neural clock model",
        second.chunkIds[0],
        CHUNK_TWO,
        "neural clock model",
        embedding(900), // orthogonal
      ),
    ]);

    expect(summary.conceptsMatchedSemantic).toBe(0);
    expect(summary.conceptsCreated).toBe(1);
    expect(await countRows("concepts")).toBe(2);
  });

  it("prefers the exact canonical key over any semantic neighbour", async () => {
    // Two genuinely distinct concepts, kept apart by orthogonal embeddings.
    const first = await seedDocument(alice, "one.pdf", [CHUNK_ONE, CHUNK_TWO]);
    await sync(alice, first.documentId, [
      candidateFor("working memory", "working memory", first.chunkIds[0], CHUNK_ONE, "Working memory", embedding(5)),
      candidateFor(
        "neural clock model",
        "neural clock model",
        first.chunkIds[1],
        CHUNK_TWO,
        "neural clock model",
        embedding(900),
      ),
    ]);
    expect(await countRows("concepts")).toBe(2);

    const second = await seedDocument(alice, "two.pdf", [CHUNK_TWO]);
    const summary = await sync(alice, second.documentId, [
      candidateFor(
        "neural clock model",
        "neural clock model",
        second.chunkIds[0],
        CHUNK_TWO,
        "neural clock model",
        // An embedding closest to a *different* concept must not win over the key.
        embedding(5),
      ),
    ]);

    expect(summary.conceptsMatchedExact).toBe(1);
    expect(summary.conceptsMatchedSemantic).toBe(0);
    expect(await countRows("concepts")).toBe(2);
  });

  it("cannot store two concepts with the same key for one user", async () => {
    await expect(
      db.sql.query(
        `INSERT INTO public.concepts (user_id, label, canonical_key) VALUES ($1,'A','dup'), ($1,'B','dup')`,
        [alice],
      ),
    ).rejects.toThrow(/concepts_user_id_canonical_key_key|duplicate key/i);
  });
});

describe("concept edges", () => {
  it("records counted co-occurrence for concepts sharing a chunk", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor(
        "attention deficit hyperactivity disorder",
        "attention deficit hyperactivity disorder",
        chunkIds[0],
        CHUNK_ONE,
        "ADHD",
      ),
    ]);

    const { rows } = await db.sql.query<{
      relation: string;
      evidence_count: number;
      document_count: number;
    }>(`SELECT relation, evidence_count, document_count FROM public.concept_edges`);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relation: "co_occurs_with",
      evidence_count: 1,
      document_count: 1,
    });
  });

  it("does not connect concepts that never share a passage", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE, CHUNK_TWO]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("neural clock model", "neural clock model", chunkIds[1], CHUNK_TWO, "neural clock model"),
    ]);
    // Same document is not evidence of a relationship; same passage is.
    expect(await countRows("concept_edges")).toBe(0);
  });

  it("stores an undirected pair exactly once", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("adhd", "adhd", chunkIds[0], CHUNK_ONE, "ADHD"),
    ]);

    expect(await countRows("concept_edges")).toBe(1);
    const { rows } = await db.sql.query<{ ordered: boolean }>(
      `SELECT (from_concept_id < to_concept_id) AS ordered FROM public.concept_edges`,
    );
    expect(rows[0].ordered).toBe(true);
  });

  it("recomputes rather than accumulating when a document is re-synced", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    const candidates = [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("adhd", "adhd", chunkIds[0], CHUNK_ONE, "ADHD"),
    ];

    await sync(alice, documentId, candidates);
    await sync(alice, documentId, candidates);

    const { rows } = await db.sql.query<{ evidence_count: number }>(
      `SELECT evidence_count FROM public.concept_edges`,
    );
    expect(rows).toHaveLength(1);
    // Incremental counting would have doubled this.
    expect(rows[0].evidence_count).toBe(1);
  });

  it("counts each additional shared passage as additional evidence", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE, CHUNK_ONE]);
    await sync(alice, documentId, [
      {
        label: "working memory",
        canonicalKey: "working memory",
        mentions: chunkIds.map((chunkId) => ({
          chunkId,
          surfaceForm: "Working memory",
          charStart: 0,
          charEnd: 14,
        })),
      },
      {
        label: "adhd",
        canonicalKey: "adhd",
        mentions: chunkIds.map((chunkId) => ({
          chunkId,
          surfaceForm: "ADHD",
          charStart: CHUNK_ONE.indexOf("ADHD"),
          charEnd: CHUNK_ONE.indexOf("ADHD") + 4,
        })),
      },
    ]);

    const { rows } = await db.sql.query<{ evidence_count: number }>(
      `SELECT evidence_count FROM public.concept_edges`,
    );
    expect(rows[0].evidence_count).toBe(2);
  });

  it("drops edges when one side is pruned", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("adhd", "adhd", chunkIds[0], CHUNK_ONE, "ADHD"),
    ]);
    expect(await countRows("concept_edges")).toBe(1);

    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    expect(await countRows("concept_edges")).toBe(0);
  });
});

describe("user isolation", () => {
  it("gives two users independent concepts for the same idea", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", [CHUNK_ONE]);
    const bobDoc = await seedDocument(bob, "b.pdf", [CHUNK_ONE]);

    await sync(alice, aliceDoc.documentId, [
      candidateFor("working memory", "working memory", aliceDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    const summary = await sync(bob, bobDoc.documentId, [
      candidateFor("working memory", "working memory", bobDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    // One user's graph must never be resolved against another's.
    expect(summary.conceptsCreated).toBe(1);
    expect(summary.conceptsMatchedExact).toBe(0);
    expect(await countRows("concepts")).toBe(2);
  });

  it("never shows one user another's concepts, mentions, or edges", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", [CHUNK_ONE]);
    await sync(alice, aliceDoc.documentId, [
      candidateFor("working memory", "working memory", aliceDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("adhd", "adhd", aliceDoc.chunkIds[0], CHUNK_ONE, "ADHD"),
    ]);

    const visible = await db.asUser(bob, async () => ({
      concepts: (await db.sql.query(`SELECT id FROM public.concepts`)).rows.length,
      mentions: (await db.sql.query(`SELECT id FROM public.concept_mentions`)).rows.length,
      edges: (await db.sql.query(`SELECT id FROM public.concept_edges`)).rows.length,
      view: (await db.sql.query(`SELECT concept_id FROM public.document_concepts`)).rows.length,
    }));

    expect(visible).toEqual({ concepts: 0, mentions: 0, edges: 0, view: 0 });

    const own = await db.asUser(alice, async () =>
      (await db.sql.query(`SELECT concept_id FROM public.document_concepts`)).rows.length,
    );
    expect(own).toBe(2);
  });

  it("refuses to attach concepts to a document the user does not own", async () => {
    const bobDoc = await seedDocument(bob, "b.pdf", [CHUNK_ONE]);
    await expect(
      sync(alice, bobDoc.documentId, [
        candidateFor("working memory", "working memory", bobDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
      ]),
    ).rejects.toThrow(/does not belong to user/);
  });

  it("limits a user's own pruning to their own graph", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", [CHUNK_ONE]);
    const bobDoc = await seedDocument(bob, "b.pdf", [CHUNK_ONE]);
    await sync(alice, aliceDoc.documentId, [
      candidateFor("working memory", "working memory", aliceDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    await sync(bob, bobDoc.documentId, [
      candidateFor("working memory", "working memory", bobDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);

    // Orphan Bob's concept, then have Alice prune. Bob's row must survive.
    await db.sql.query(`DELETE FROM public.documents WHERE id = $1`, [bobDoc.documentId]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.prune_orphan_concepts()`));

    expect(await countRows("concepts", "user_id = $1", [bob])).toBe(1);
    expect(await countRows("concepts", "user_id = $1", [alice])).toBe(1);
  });

  it("blocks direct writes to derived concept tables", async () => {
    // Only the SECURITY DEFINER functions may write, so a client cannot forge
    // a concept that no source text supports.
    await expect(
      db.asUser(alice, () =>
        db.sql.query(
          `INSERT INTO public.concepts (user_id, label, canonical_key) VALUES ($1,'forged','forged')`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("keeps the write functions out of reach of ordinary users", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", [CHUNK_ONE]);
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`SELECT public.sync_document_concepts($1,$2,'[]'::jsonb,0.95)`, [
          alice,
          aliceDoc.documentId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(alice, () => db.sql.query(`SELECT public.rebuild_concept_projections($1)`, [bob])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("removes a user's whole graph with their account", async () => {
    const aliceDoc = await seedDocument(alice, "a.pdf", [CHUNK_ONE]);
    await sync(alice, aliceDoc.documentId, [
      candidateFor("working memory", "working memory", aliceDoc.chunkIds[0], CHUNK_ONE, "Working memory"),
      candidateFor("adhd", "adhd", aliceDoc.chunkIds[0], CHUNK_ONE, "ADHD"),
    ]);

    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    expect(await countRows("concepts")).toBe(0);
    expect(await countRows("concept_mentions")).toBe(0);
    expect(await countRows("concept_edges")).toBe(0);
  });
});

describe("malformed input", () => {
  it("rejects candidates that are not a JSON array", async () => {
    const { documentId } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await expect(
      db.sql.query(`SELECT public.sync_document_concepts($1,$2,'{"nope":true}'::jsonb,0.95)`, [
        alice,
        documentId,
      ]),
    ).rejects.toThrow(/must be a JSON array/);
  });

  it("accepts an empty candidate list as a valid, concept-free result", async () => {
    const { documentId } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    const summary = await sync(alice, documentId, []);
    expect(summary).toMatchObject({ conceptsCreated: 0, mentionsWritten: 0, edges: 0 });
  });

  it("rejects a mention pointing at a chunk that does not exist", async () => {
    const { documentId } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await expect(
      sync(alice, documentId, [
        {
          label: "working memory",
          canonicalKey: "working memory",
          mentions: [
            {
              chunkId: "99999999-9999-4999-8999-999999999999",
              surfaceForm: "Working memory",
              charStart: 0,
              charEnd: 14,
            },
          ],
        },
      ]),
      // Caught by the chunk-ownership pre-validation now, ahead of the foreign
      // key, so the whole sync is rejected before any row is written.
    ).rejects.toThrow(/chunk\(s\) outside document/);
  });

  it("stores a concept without an embedding when none was produced", async () => {
    const { documentId, chunkIds } = await seedDocument(alice, "paper.pdf", [CHUNK_ONE]);
    await sync(alice, documentId, [
      candidateFor("working memory", "working memory", chunkIds[0], CHUNK_ONE, "Working memory"),
    ]);
    const { rows } = await db.sql.query<{ embedding: unknown }>(
      `SELECT embedding FROM public.concepts`,
    );
    expect(rows[0].embedding).toBeNull();
    expect(await countRows("concepts")).toBe(1);
  });
});
