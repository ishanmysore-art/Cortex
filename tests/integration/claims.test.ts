/**
 * Database-level tests for explicit claims, run against the real migration files.
 *
 * The properties under test are the ones that make the model trustworthy: a
 * claim cannot exist without evidence, evidence cannot dangle, history is never
 * overwritten, and no user can reach another's claims.
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
    DELETE FROM public.claim_evidence;
    DELETE FROM public.user_claims;
    DELETE FROM public.observations;
    DELETE FROM public.memories;
    DELETE FROM public.messages;
    DELETE FROM public.conversations;
  `);
  alice = await db.createUser("alice@example.test");
  bob = await db.createUser("bob@example.test");
});

const BELIEF = "I think retrieval alone isn't enough for a second brain.";
const EXCERPT = "retrieval alone isn't enough for a second brain";

async function seedMessage(userId: string, content = BELIEF, statedAt = "2026-04-01T10:00:00.000Z") {
  const conversationId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.conversations (user_id, title) VALUES ($1,'chat') RETURNING id`,
      [userId],
    )
  ).rows[0].id;
  const messageId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.messages (conversation_id, role, content, created_at)
       VALUES ($1,'user',$2,$3) RETURNING id`,
      [conversationId, content, statedAt],
    )
  ).rows[0].id;
  return { conversationId, messageId, content };
}

type Candidate = {
  claimType: string;
  statement: string;
  canonicalKey: string;
  excerpt: string;
  charStart: number;
  charEnd: number;
};

function candidate(
  content: string,
  excerpt: string,
  claimType = "belief",
  statement = "User thinks retrieval alone is insufficient for a second brain.",
): Candidate {
  const charStart = content.indexOf(excerpt);
  if (charStart === -1) throw new Error(`Test setup error: "${excerpt}" not in message.`);
  return {
    claimType,
    statement,
    canonicalKey: statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    excerpt,
    charStart,
    charEnd: charStart + excerpt.length,
  };
}

/** Calls the RPC as the given user, since it resolves ownership from the session. */
async function record(userId: string, messageId: string, candidates: Candidate[]) {
  return db.asUser(userId, async () => {
    const { rows } = await db.sql.query<{ result: Record<string, number> }>(
      `SELECT public.record_user_claims($1,$2::jsonb) AS result`,
      [messageId, JSON.stringify(candidates)],
    );
    return rows[0].result;
  });
}

const countRows = async (table: string, where = "TRUE", params: unknown[] = []) =>
  Number(
    (
      await db.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${table} WHERE ${where}`,
        params,
      )
    ).rows[0].count,
  );

const claimRow = async () =>
  (
    await db.sql.query<{
      id: string;
      claim_type: string;
      asserted_by: string;
      statement: string;
      status: string;
      confidence: string;
      valid_from: Date;
      valid_to: Date | null;
      first_stated_at: Date;
      last_stated_at: Date;
      evidence_count: number;
    }>(`SELECT * FROM public.user_claims ORDER BY created_at LIMIT 1`)
  ).rows[0];

describe("recording an explicit claim", () => {
  it("writes the claim, its evidence, and the observation together", async () => {
    const { messageId } = await seedMessage(alice);
    const summary = await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    expect(summary).toMatchObject({ claimsCreated: 1, evidenceWritten: 1 });

    const claim = await claimRow();
    expect(claim.claim_type).toBe("belief");
    // M3 never asserts anything itself.
    expect(claim.asserted_by).toBe("user");
    expect(claim.status).toBe("active");
    expect(Number(claim.confidence)).toBe(1);
    expect(claim.evidence_count).toBe(1);

    const { rows: evidence } = await db.sql.query<{
      relation: string;
      excerpt: string;
      occurred_at: Date;
      source_message_id: string;
    }>(`SELECT relation, excerpt, occurred_at, source_message_id FROM public.claim_evidence`);
    expect(evidence[0]).toMatchObject({ relation: "originates", excerpt: EXCERPT, source_message_id: messageId });

    const { rows: observations } = await db.sql.query<{ event_type: string; source_id: string }>(
      `SELECT event_type, source_id FROM public.observations WHERE event_type = 'claim_stated'`,
    );
    expect(observations).toHaveLength(1);
    expect(observations[0].source_id).toBe(messageId);
  });

  it("dates the claim to when the user said it, not when the row was written", async () => {
    const { messageId } = await seedMessage(alice, BELIEF, "2026-04-01T10:00:00.000Z");
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    const claim = await claimRow();
    expect(new Date(claim.valid_from).toISOString()).toBe("2026-04-01T10:00:00.000Z");
    expect(new Date(claim.first_stated_at).toISOString()).toBe("2026-04-01T10:00:00.000Z");
    expect(claim.valid_to).toBeNull();
  });

  it("points evidence at the observation that records the statement", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    const { rows } = await db.sql.query<{ matched: string }>(
      `SELECT count(*)::text AS matched
       FROM public.claim_evidence e
       JOIN public.observations o ON o.id = e.observation_id
       WHERE o.event_type = 'claim_stated'`,
    );
    expect(rows[0].matched).toBe("1");
  });

  it("re-verifies the span and refuses a hallucinated excerpt", async () => {
    const { messageId } = await seedMessage(alice);
    // Defense in depth: even if the application layer were bypassed, the
    // database will not store a claim whose words are not in the message.
    await expect(
      record(alice, messageId, [
        { ...candidate(BELIEF, EXCERPT), excerpt: "something never written" },
      ]),
    ).rejects.toThrow(/does not match message/);
    expect(await countRows("user_claims")).toBe(0);
  });

  it("refuses a span that points outside the quoted text", async () => {
    const { messageId } = await seedMessage(alice);
    const shifted = { ...candidate(BELIEF, EXCERPT), charStart: 0 };
    await expect(record(alice, messageId, [shifted])).rejects.toThrow(/does not match message/);
  });

  it("refuses a malformed span", async () => {
    const { messageId } = await seedMessage(alice);
    await expect(
      record(alice, messageId, [{ ...candidate(BELIEF, EXCERPT), charEnd: 0 }]),
    ).rejects.toThrow(/invalid span/);
  });

  it("refuses candidates that are not an array", async () => {
    const { messageId } = await seedMessage(alice);
    await expect(
      db.asUser(alice, () =>
        db.sql.query(`SELECT public.record_user_claims($1,'{"a":1}'::jsonb)`, [messageId]),
      ),
    ).rejects.toThrow(/must be a JSON array/);
  });

  it("refuses to attribute a claim to an assistant message", async () => {
    const { conversationId } = await seedMessage(alice);
    const assistantId = (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.messages (conversation_id, role, content)
         VALUES ($1,'assistant',$2) RETURNING id`,
        [conversationId, BELIEF],
      )
    ).rows[0].id;

    await expect(record(alice, assistantId, [candidate(BELIEF, EXCERPT)])).rejects.toThrow(
      /not a user message/,
    );
  });
});

describe("the evidence invariant", () => {
  it("refuses a claim that reaches commit with no evidence", async () => {
    // The deferred constraint trigger is what makes "no claim without evidence"
    // a database fact rather than an application convention.
    await expect(
      db.sql.exec(`
        BEGIN;
        INSERT INTO public.user_claims
          (user_id, claim_type, statement, canonical_key, valid_from, first_stated_at, last_stated_at)
        VALUES ('${alice}', 'belief', 'User thinks X.', 'user thinks x', NOW(), NOW(), NOW());
        COMMIT;
      `),
    ).rejects.toThrow(/no evidence/);
    expect(await countRows("user_claims")).toBe(0);
  });

  it("removes a claim when its last evidence is deleted", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    expect(await countRows("user_claims")).toBe(1);

    // Deleting the observation is the user exercising erasure. The claim it
    // justified must go with it rather than standing unsupported.
    await db.sql.query(`DELETE FROM public.observations WHERE event_type = 'claim_stated'`);

    expect(await countRows("claim_evidence")).toBe(0);
    expect(await countRows("user_claims")).toBe(0);
  });

  it("keeps a claim alive while other evidence remains", async () => {
    const first = await seedMessage(alice, BELIEF, "2026-04-01T10:00:00.000Z");
    const second = await seedMessage(alice, BELIEF, "2026-05-01T10:00:00.000Z");
    await record(alice, first.messageId, [candidate(BELIEF, EXCERPT)]);
    await record(alice, second.messageId, [candidate(BELIEF, EXCERPT)]);

    expect(await countRows("user_claims")).toBe(1);
    expect(await countRows("claim_evidence")).toBe(2);

    await db.sql.query(
      `DELETE FROM public.observations WHERE id = (
         SELECT observation_id FROM public.claim_evidence ORDER BY occurred_at LIMIT 1)`,
    );

    expect(await countRows("user_claims")).toBe(1);
    // The surviving claim must report the evidence it actually still has.
    expect((await claimRow()).evidence_count).toBe(1);
    expect(await countRows("claim_evidence")).toBe(1);
  });

  it("leaves no dangling evidence when a claim is erased", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    await db.asUser(alice, () => db.sql.query(`DELETE FROM public.user_claims`));
    expect(await countRows("claim_evidence")).toBe(0);
    // The observation of what was said survives; only the interpretation went.
    expect(await countRows("observations", "event_type = 'claim_stated'")).toBe(1);
  });

  it("never leaves an evidence row without both endpoints", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    const orphans = await countRows(
      "claim_evidence e",
      `NOT EXISTS (SELECT 1 FROM public.user_claims c WHERE c.id = e.claim_id)
       OR NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.id = e.observation_id)`,
    );
    expect(orphans).toBe(0);
  });
});

describe("temporal behaviour", () => {
  it("treats restating a claim as more evidence, never a second claim", async () => {
    const first = await seedMessage(alice, BELIEF, "2026-04-01T10:00:00.000Z");
    const second = await seedMessage(alice, BELIEF, "2026-06-01T10:00:00.000Z");

    await record(alice, first.messageId, [candidate(BELIEF, EXCERPT)]);
    const summary = await record(alice, second.messageId, [candidate(BELIEF, EXCERPT)]);

    expect(summary).toMatchObject({ claimsCreated: 0, claimsReinforced: 1, evidenceWritten: 1 });
    expect(await countRows("user_claims")).toBe(1);

    const claim = await claimRow();
    expect(new Date(claim.first_stated_at).toISOString()).toBe("2026-04-01T10:00:00.000Z");
    expect(new Date(claim.last_stated_at).toISOString()).toBe("2026-06-01T10:00:00.000Z");
    expect(claim.evidence_count).toBe(2);
  });

  it("keeps a later, different statement as its own claim", async () => {
    const held = "I think AI should augment human reasoning.";
    const changed = "I no longer think AI should primarily augment human reasoning.";
    const first = await seedMessage(alice, held, "2026-01-01T00:00:00.000Z");
    const second = await seedMessage(alice, changed, "2026-07-01T00:00:00.000Z");

    await record(alice, first.messageId, [
      candidate(held, "AI should augment human reasoning", "belief", "User thinks AI should augment human reasoning."),
    ]);
    await record(alice, second.messageId, [
      candidate(
        changed,
        "no longer think AI should primarily augment human reasoning",
        "belief",
        "User no longer thinks AI should primarily augment human reasoning.",
      ),
    ]);

    // Both survive. Cortex does not decide which one is true, and the change of
    // mind is itself the valuable record.
    expect(await countRows("user_claims")).toBe(2);
    expect(await countRows("user_claims", "status = 'active'")).toBe(2);
  });

  it("is idempotent when the same message is reprocessed", async () => {
    const { messageId } = await seedMessage(alice);
    const candidates = [candidate(BELIEF, EXCERPT)];

    await record(alice, messageId, candidates);
    const second = await record(alice, messageId, candidates);
    await record(alice, messageId, candidates);

    expect(second.evidenceWritten).toBe(0);
    expect(await countRows("user_claims")).toBe(1);
    expect(await countRows("claim_evidence")).toBe(1);
    expect(await countRows("observations", "event_type = 'claim_stated'")).toBe(1);
  });

  it("closes a claim without erasing what was said", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const before = await claimRow();

    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [before.id]),
    );

    const after = await claimRow();
    expect(after.status).toBe("retracted");
    expect(after.valid_to).not.toBeNull();
    // The wording and its evidence are untouched.
    expect(after.statement).toBe(before.statement);
    expect(await countRows("claim_evidence")).toBe(1);
  });

  it("records the correction itself as an observation", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'archived')`, [claim.id]),
    );

    const { rows } = await db.sql.query<{ source_id: string }>(
      `SELECT source_id FROM public.observations WHERE event_type = 'claim_archived'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(claim.id);
  });

  it("can restore a closed claim", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    await db.asUser(alice, () => db.sql.query(`SELECT public.close_user_claim($1,'archived')`, [claim.id]));
    await db.asUser(alice, () => db.sql.query(`SELECT public.close_user_claim($1,'active')`, [claim.id]));

    const restored = await claimRow();
    expect(restored.status).toBe("active");
    expect(restored.valid_to).toBeNull();
  });

  it("requires anything no longer current to say when it stopped", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    await expect(
      db.sql.query(`UPDATE public.user_claims SET status = 'retracted' WHERE id = $1`, [claim.id]),
    ).rejects.toThrow(/user_claims_closed_when_inactive/);
  });
});

describe("deduplication", () => {
  it("cannot store the same claim twice for one user", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    await expect(
      db.sql.query(
        `INSERT INTO public.user_claims
           (user_id, claim_type, statement, canonical_key, valid_from, first_stated_at, last_stated_at)
         VALUES ($1,$2,'dup',$3,NOW(),NOW(),NOW())`,
        [alice, claim.claim_type, claim.statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()],
      ),
    ).rejects.toThrow(/duplicate key|user_claims_user_id_claim_type_canonical_key_key/i);
  });

  it("keeps the same wording under different types apart", async () => {
    const message = "I want to understand cognition and I think cognition is understandable.";
    const { messageId } = await seedMessage(alice, message);
    await record(alice, messageId, [
      candidate(message, "understand cognition", "goal", "User cares about cognition."),
      candidate(message, "cognition is understandable", "belief", "User cares about cognition."),
    ]);
    // Same canonical key, different category: two claims, nothing merged away.
    expect(await countRows("user_claims")).toBe(2);
  });
});

describe("security and isolation", () => {
  it("never shows one user another's claims or evidence", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    const visible = await db.asUser(bob, async () => ({
      claims: (await db.sql.query(`SELECT id FROM public.user_claims`)).rows.length,
      evidence: (await db.sql.query(`SELECT id FROM public.claim_evidence`)).rows.length,
    }));
    expect(visible).toEqual({ claims: 0, evidence: 0 });

    const own = await db.asUser(alice, async () =>
      (await db.sql.query(`SELECT id FROM public.user_claims`)).rows.length,
    );
    expect(own).toBe(1);
  });

  it("resolves ownership from the session, so a claim cannot be forged onto another user", async () => {
    const aliceMessage = await seedMessage(alice);
    // Bob calls the recorder with Alice's message id. The function derives the
    // owner from auth.uid(), so the message simply does not resolve for him.
    await expect(record(bob, aliceMessage.messageId, [candidate(BELIEF, EXCERPT)])).rejects.toThrow(
      /not a user message/,
    );
    expect(await countRows("user_claims")).toBe(0);
  });

  it("blocks direct inserts into the claim tables", async () => {
    await expect(
      db.asUser(alice, () =>
        db.sql.query(
          `INSERT INTO public.user_claims
             (user_id, claim_type, statement, canonical_key, valid_from, first_stated_at, last_stated_at)
           VALUES ($1,'belief','forged','forged',NOW(),NOW(),NOW())`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("blocks editing a statement the user did not make", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    // No UPDATE policy exists, so a client cannot rewrite its own history either.
    const result = await db.asUser(alice, () =>
      db.sql.query(`UPDATE public.user_claims SET statement = 'rewritten' WHERE id = $1`, [claim.id]),
    );
    expect(result.affectedRows).toBe(0);
    expect((await claimRow()).statement).toBe(claim.statement);
  });

  it("cannot close another user's claim", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);
    const claim = await claimRow();

    const result = await db.asUser(bob, async () =>
      (
        await db.sql.query<{ r: { updated: number } }>(
          `SELECT public.close_user_claim($1,'retracted') AS r`,
          [claim.id],
        )
      ).rows[0].r,
    );
    expect(result.updated).toBe(0);
    expect((await claimRow()).status).toBe("active");
  });

  it("rejects an unauthenticated recorder call", async () => {
    const { messageId } = await seedMessage(alice);
    await expect(
      db.asServiceRole(() =>
        db.sql.query(`SELECT public.record_user_claims($1,'[]'::jsonb)`, [messageId]),
      ),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("removes a user's whole model with their account", async () => {
    const { messageId } = await seedMessage(alice);
    await record(alice, messageId, [candidate(BELIEF, EXCERPT)]);

    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    expect(await countRows("user_claims")).toBe(0);
    expect(await countRows("claim_evidence")).toBe(0);
    expect(await countRows("observations")).toBe(0);
  });
});

describe("identity continuity with memories", () => {
  async function seedMemory(userId: string, content: string, createdAt = "2026-02-01T00:00:00.000Z") {
    return (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.memories (user_id, content, created_at) VALUES ($1,$2,$3) RETURNING id`,
        [userId, content, createdAt],
      )
    ).rows[0].id;
  }

  it("maps a memory to a claim and creates its missing observation", async () => {
    // A memory predating the observation log has no `memory_stated` event, so
    // the mapping must create one rather than leave the claim unevidenced.
    const memoryId = await seedMemory(alice, "I work mostly on cognitive architectures.");
    await db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId]));

    const { rows } = await db.sql.query<{
      claim_type: string;
      source_memory_id: string;
      confidence_method: string;
      valid_from: Date;
    }>(`SELECT claim_type, source_memory_id, confidence_method, valid_from FROM public.user_claims`);

    expect(rows).toHaveLength(1);
    // `note`, not a guessed category: guessing would be an inference.
    expect(rows[0].claim_type).toBe("note");
    expect(rows[0].source_memory_id).toBe(memoryId);
    expect(rows[0].confidence_method).toBe("user_stated_memory");
    expect(new Date(rows[0].valid_from).toISOString()).toBe("2026-02-01T00:00:00.000Z");

    expect(await countRows("observations", "event_type = 'memory_stated'")).toBe(1);
    expect(await countRows("claim_evidence")).toBe(1);
  });

  it("reuses an existing memory_stated observation rather than duplicating it", async () => {
    const memoryId = await seedMemory(alice, "I care about evidence-backed systems.");
    await db.sql.query(
      `INSERT INTO public.observations
         (user_id, event_type, event_category, actor, source_type, source_id, payload, dedupe_key)
       VALUES ($1,'memory_stated','explicit_signal','user','memory',$2,'{}'::jsonb,$3)`,
      [alice, memoryId, `memory_stated:${memoryId}`],
    );

    await db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId]));
    expect(await countRows("observations", "event_type = 'memory_stated'")).toBe(1);
    expect(await countRows("user_claims")).toBe(1);
  });

  it("is idempotent", async () => {
    const memoryId = await seedMemory(alice, "I care about evidence-backed systems.");
    for (let i = 0; i < 3; i += 1) {
      await db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId]));
    }
    expect(await countRows("user_claims")).toBe(1);
    expect(await countRows("claim_evidence")).toBe(1);
  });

  it("carries an archived memory across as a closed claim", async () => {
    const memoryId = await seedMemory(alice, "I used to focus on retrieval quality.");
    await db.sql.query(`UPDATE public.memories SET status = 'archived' WHERE id = $1`, [memoryId]);
    await db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId]));

    const { rows } = await db.sql.query<{ status: string; valid_to: Date | null }>(
      `SELECT status, valid_to FROM public.user_claims`,
    );
    expect(rows[0].status).toBe("archived");
    expect(rows[0].valid_to).not.toBeNull();
  });

  it("does not let one user map another's memory", async () => {
    const memoryId = await seedMemory(bob, "Bob's private note.");
    await expect(
      db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId])),
    ).rejects.toThrow(/does not belong to the caller/);
    expect(await countRows("user_claims")).toBe(0);
  });

  it("leaves the legacy memory row in place", async () => {
    const memoryId = await seedMemory(alice, "I care about evidence-backed systems.");
    await db.asUser(alice, () => db.sql.query(`SELECT public.sync_memory_claim($1)`, [memoryId]));
    // The old system keeps working until the replacement is proven.
    expect(await countRows("memories", "id = $1", [memoryId])).toBe(1);
  });
});
