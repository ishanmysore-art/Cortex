/**
 * Evidence-backed inference.
 *
 * This is the first milestone in which Cortex asserts something the user did not
 * say, so the tests are weighted toward what must NOT happen: inference from one
 * occasion, from one sitting, from document content, or over the user's own
 * contradiction — and re-inference after a rejection.
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
    DELETE FROM public.claim_rejections;
    DELETE FROM public.claim_evidence;
    DELETE FROM public.user_claims;
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

/**
 * Creates a concept from a document, as M2 would.
 *
 * `surfaceForms` are the spans M2 attributed to the concept. They matter: the
 * inference matches a statement against a concept's canonical key OR any of its
 * recorded surface forms, so this fixture must mirror what extraction would
 * actually have produced.
 */
async function seedConcept(
  userId: string,
  label = "working memory",
  key = "working memory",
  surfaceForms: string[] = ["Working memory", "ADHD"],
) {
  const documentId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.documents (user_id, title, file_type, status, file_path, created_at)
       VALUES ($1,$2,'pdf','ready',$3,'2025-01-01') RETURNING id`,
      [userId, `${key}.pdf`, `${userId}/${key}.pdf`],
    )
  ).rows[0].id;
  const chunkId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.document_chunks (document_id, chunk_index, content, page_start, page_end)
       VALUES ($1,0,$2,1,1) RETURNING id`,
      [documentId, CHUNK_TEXT],
    )
  ).rows[0].id;

  await db.sql.query(
    `SELECT public.sync_document_concepts($1,$2,$3::jsonb,0.95)`,
    [
      userId,
      documentId,
      JSON.stringify([
        {
          label,
          canonicalKey: key,
          mentions: surfaceForms.map((surfaceForm) => ({
            chunkId,
            surfaceForm,
            charStart: CHUNK_TEXT.indexOf(surfaceForm),
            charEnd: CHUNK_TEXT.indexOf(surfaceForm) + surfaceForm.length,
          })),
        },
      ]),
    ],
  );
  return { documentId, chunkId };
}

/**
 * Records one explicit user claim in its own message and conversation.
 *
 * Separate conversations by default because independence is defined that way;
 * pass `conversationId` to reuse one and reproduce a single sitting.
 */
async function statedClaim(
  userId: string,
  {
    text,
    excerpt,
    statement,
    claimType = "goal",
    statedAt,
    conversationId,
  }: {
    text: string;
    excerpt: string;
    statement: string;
    claimType?: string;
    statedAt: string;
    conversationId?: string;
  },
) {
  const conversation =
    conversationId ??
    (
      await db.sql.query<{ id: string }>(
        `INSERT INTO public.conversations (user_id, title) VALUES ($1,'c') RETURNING id`,
        [userId],
      )
    ).rows[0].id;

  const messageId = (
    await db.sql.query<{ id: string }>(
      `INSERT INTO public.messages (conversation_id, role, content, created_at)
       VALUES ($1,'user',$2,$3) RETURNING id`,
      [conversation, text, statedAt],
    )
  ).rows[0].id;

  const charStart = text.indexOf(excerpt);
  if (charStart === -1) throw new Error(`Test setup error: "${excerpt}" not in message.`);

  await db.asUser(userId, () =>
    db.sql.query(`SELECT public.record_user_claims($1,$2::jsonb)`, [
      messageId,
      JSON.stringify([
        {
          claimType,
          statement,
          canonicalKey: statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
          excerpt,
          charStart,
          charEnd: charStart + excerpt.length,
        },
      ]),
    ]),
  );

  return { conversationId: conversation, messageId };
}

/** Three independent statements naming "working memory", 30 days apart. */
async function seedQualifyingEvidence(userId: string) {
  await statedClaim(userId, {
    text: "I want to build a tool around working memory.",
    excerpt: "build a tool around working memory",
    statement: "User wants to build a tool around working memory.",
    statedAt: "2026-01-01T00:00:00.000Z",
  });
  await statedClaim(userId, {
    text: "I'm trying to understand working memory limits.",
    excerpt: "understand working memory limits",
    statement: "User is trying to understand working memory limits.",
    claimType: "open_question",
    statedAt: "2026-01-15T00:00:00.000Z",
  });
  await statedClaim(userId, {
    text: "I'm interested in working memory research.",
    excerpt: "working memory research",
    statement: "User is interested in working memory research.",
    claimType: "interest",
    statedAt: "2026-01-31T00:00:00.000Z",
  });
}

const infer = (userId: string) =>
  db.sql
    .query<{ result: Record<string, number | string> }>(
      `SELECT public.infer_sustained_interest($1) AS result`,
      [userId],
    )
    .then((r) => r.rows[0].result);

const inferredClaims = async () =>
  (
    await db.sql.query<{
      id: string;
      claim_type: string;
      asserted_by: string;
      statement: string;
      status: string;
      confidence: string;
      confidence_method: string;
      inference_rule: string;
      inference_min_evidence: number;
      evidence_count: number;
      valid_to: Date | null;
    }>(`SELECT * FROM public.user_claims WHERE asserted_by = 'cortex' ORDER BY created_at`)
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

describe("the evidentiary bar", () => {
  it("infers from three independent statements over more than a fortnight", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);

    const summary = await infer(alice);
    expect(summary.claimsCreated).toBe(1);

    const [claim] = await inferredClaims();
    expect(claim.claim_type).toBe("sustained_interest");
    expect(claim.asserted_by).toBe("cortex");
    expect(claim.status).toBe("active");
    expect(claim.inference_rule).toBe("sustained_interest_v1");
    expect(claim.inference_min_evidence).toBe(3);
    // Every contributing statement is cited.
    expect(claim.evidence_count).toBe(3);
  });

  it("states its reasoning as an inspectable sentence, not a bare score", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);

    const [claim] = await inferredClaims();
    expect(claim.confidence_method).toMatch(/3 independent explicit claims naming "working memory"/);
    expect(claim.confidence_method).toMatch(/across 3 conversations over 30 days/);
    expect(claim.confidence_method).toMatch(/no contradicting claim/);
    // An inference is never asserted with certainty.
    expect(Number(claim.confidence)).toBeLessThan(1);
  });

  it("refuses to infer from two statements", async () => {
    await seedConcept(alice);
    await statedClaim(alice, {
      text: "I want to build a tool around working memory.",
      excerpt: "build a tool around working memory",
      statement: "User wants to build a tool around working memory.",
      statedAt: "2026-01-01T00:00:00.000Z",
    });
    await statedClaim(alice, {
      text: "I'm interested in working memory research.",
      excerpt: "working memory research",
      statement: "User is interested in working memory research.",
      claimType: "interest",
      statedAt: "2026-02-01T00:00:00.000Z",
    });

    expect((await infer(alice)).claimsCreated).toBe(0);
    expect(await inferredClaims()).toHaveLength(0);
  });

  it("refuses to infer from a single occasion however emphatic", async () => {
    await seedConcept(alice);
    const first = await statedClaim(alice, {
      text: "I want to build a tool around working memory.",
      excerpt: "build a tool around working memory",
      statement: "User wants to build a tool around working memory.",
      statedAt: "2026-01-01T00:00:00.000Z",
    });
    // Same conversation, same day: one occasion, not three.
    await statedClaim(alice, {
      text: "I'm trying to understand working memory limits.",
      excerpt: "understand working memory limits",
      statement: "User is trying to understand working memory limits.",
      claimType: "open_question",
      statedAt: "2026-01-01T01:00:00.000Z",
      conversationId: first.conversationId,
    });
    await statedClaim(alice, {
      text: "I'm interested in working memory research.",
      excerpt: "working memory research",
      statement: "User is interested in working memory research.",
      claimType: "interest",
      statedAt: "2026-01-01T02:00:00.000Z",
      conversationId: first.conversationId,
    });

    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("refuses when three statements fall inside the minimum span", async () => {
    await seedConcept(alice);
    for (const [index, day] of ["01", "02", "03"].entries()) {
      await statedClaim(alice, {
        text: `I want to study working memory topic ${index}.`,
        excerpt: `study working memory topic ${index}`,
        statement: `User wants to study working memory topic ${index}.`,
        statedAt: `2026-01-${day}T00:00:00.000Z`,
      });
    }
    // Three conversations, three days, but only two days apart.
    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("never infers from document content", async () => {
    // A concept exists and is heavily mentioned, but the user never said
    // anything about it. Reading about X is still not believing X.
    await seedConcept(alice);
    expect((await infer(alice)).claimsCreated).toBe(0);
    expect(await inferredClaims()).toHaveLength(0);
  });

  it("does not count a restated claim as a second occasion", async () => {
    await seedConcept(alice);
    const statement = "User wants to build a tool around working memory.";
    for (const date of ["2026-01-01", "2026-01-20", "2026-02-10"]) {
      await statedClaim(alice, {
        text: "I want to build a tool around working memory.",
        excerpt: "build a tool around working memory",
        statement,
        statedAt: `${date}T00:00:00.000Z`,
      });
    }
    // M3 stores this as ONE claim with three pieces of evidence, so it
    // contributes one distinct claim, not three.
    expect(await countRows("user_claims", "asserted_by = 'user'")).toBe(1);
    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("ignores a concept the statements never name", async () => {
    // A concept whose label and surface forms share nothing with what the user
    // wrote about.
    await seedConcept(alice, "reading comprehension", "reading comprehension", [
      "reading comprehension",
    ]);
    await seedQualifyingEvidence(alice);
    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("inherits M2's surface-form attribution, for better and worse", async () => {
    // Matching through surface forms is what lets "ADHD" reach an expanded
    // concept label — and it means a surface form M2 attributed wrongly would
    // pull the inference with it. The dependency is real and worth pinning:
    // inference is only as accurate as the extraction beneath it.
    await seedConcept(alice, "reading comprehension", "reading comprehension", [
      "Working memory",
    ]);
    await seedQualifyingEvidence(alice);
    expect((await infer(alice)).claimsCreated).toBe(1);
  });

  it("matches a concept through a surface form its documents used", async () => {
    // The concept's canonical label is the expanded name; the user writes "ADHD",
    // which reaches it only because M2 recorded that surface form.
    await seedConcept(
      alice,
      "attention deficit hyperactivity disorder",
      "attention deficit hyperactivity disorder",
      ["ADHD"],
    );
    await statedClaim(alice, {
      text: "I want to build a tool for ADHD research.",
      excerpt: "build a tool for ADHD research",
      statement: "User wants to build a tool for ADHD research.",
      statedAt: "2026-01-01T00:00:00.000Z",
    });
    await statedClaim(alice, {
      text: "I'm trying to understand ADHD diagnosis.",
      excerpt: "understand ADHD diagnosis",
      statement: "User is trying to understand ADHD diagnosis.",
      claimType: "open_question",
      statedAt: "2026-01-15T00:00:00.000Z",
    });
    await statedClaim(alice, {
      text: "I'm interested in ADHD literature.",
      excerpt: "ADHD literature",
      statement: "User is interested in ADHD literature.",
      claimType: "interest",
      statedAt: "2026-01-31T00:00:00.000Z",
    });

    expect((await infer(alice)).claimsCreated).toBe(1);
  });

  it("does not match across a word-form difference", async () => {
    // Exact whole-phrase containment, no stemming: "transformers" is not
    // "transformer". Under-matching is the intended direction of error.
    // No surface form to widen the match; only the canonical key applies.
    await seedConcept(alice, "transformer", "transformer", ["Working memory"]);
    for (const [index, date] of ["2026-01-01", "2026-01-15", "2026-01-31"].entries()) {
      await statedClaim(alice, {
        text: `I want to study transformers approach ${index}.`,
        excerpt: `study transformers approach ${index}`,
        statement: `User wants to study transformers approach ${index}.`,
        statedAt: `${date}T00:00:00.000Z`,
      });
    }
    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("is idempotent across repeated passes", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);

    await infer(alice);
    const second = await infer(alice);
    await infer(alice);

    expect(second.claimsCreated).toBe(0);
    expect(second.claimsRefreshed).toBe(1);
    expect(await inferredClaims()).toHaveLength(1);
    expect(await countRows("claim_evidence", "relation = 'supports'")).toBe(3);
  });
});

describe("never overriding the user", () => {
  it("does not infer when the user retracted a claim naming the concept", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);

    const { rows } = await db.sql.query<{ id: string }>(
      `SELECT id FROM public.user_claims WHERE asserted_by = 'user' ORDER BY created_at LIMIT 1`,
    );
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [rows[0].id]),
    );

    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("does not infer over an explicit reversal", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await statedClaim(alice, {
      text: "I no longer want to work on working memory.",
      excerpt: "no longer want to work on working memory",
      statement: "User no longer wants to work on working memory.",
      claimType: "belief",
      statedAt: "2026-03-01T00:00:00.000Z",
    });

    expect((await infer(alice)).claimsCreated).toBe(0);
  });

  it("ignores archived user claims as evidence", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);

    const { rows } = await db.sql.query<{ id: string }>(
      `SELECT id FROM public.user_claims WHERE asserted_by = 'user' ORDER BY created_at LIMIT 1`,
    );
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'archived')`, [rows[0].id]),
    );

    // Two active statements left, below the bar.
    expect((await infer(alice)).claimsCreated).toBe(0);
  });
});

describe("rejection outranks re-inference", () => {
  async function inferThenReject() {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    const [claim] = await inferredClaims();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [claim.id]),
    );
    return claim;
  }

  it("records a standing refusal keyed on the claim's identity", async () => {
    const claim = await inferThenReject();
    const { rows } = await db.sql.query<{ claim_type: string; canonical_key: string; reason: string }>(
      `SELECT claim_type, canonical_key, reason FROM public.claim_rejections`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ claim_type: "sustained_interest", reason: "retracted" });
    expect(rows[0].canonical_key).toBe("sustained interest in working memory");
    expect(claim.id).toBeDefined();
  });

  it("does not recreate a rejected claim however strong the evidence", async () => {
    await inferThenReject();

    // More evidence than before, and a wider span.
    await statedClaim(alice, {
      text: "I want to keep working memory as my main focus.",
      excerpt: "keep working memory as my main focus",
      statement: "User wants to keep working memory as their main focus.",
      statedAt: "2026-04-01T00:00:00.000Z",
    });

    const summary = await infer(alice);
    expect(summary.claimsCreated).toBe(0);
    expect(summary.skippedRejected).toBe(1);
    expect(await countRows("user_claims", "asserted_by = 'cortex' AND status = 'active'")).toBe(0);
  });

  it("survives deletion of the rejected claim itself", async () => {
    const claim = await inferThenReject();
    // Keying the refusal on claim id would have erased it here.
    await db.asUser(alice, () =>
      db.sql.query(`DELETE FROM public.user_claims WHERE id = $1`, [claim.id]),
    );
    expect(await countRows("claim_rejections")).toBe(1);

    const summary = await infer(alice);
    expect(summary.claimsCreated).toBe(0);
    expect(summary.skippedRejected).toBe(1);
  });

  it("lets the user withdraw their refusal by restoring the claim", async () => {
    const claim = await inferThenReject();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'active')`, [claim.id]),
    );
    expect(await countRows("claim_rejections")).toBe(0);

    const summary = await infer(alice);
    expect(summary.skippedRejected).toBe(0);
  });

  it("records an archive as a refusal too", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    const [claim] = await inferredClaims();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'archived')`, [claim.id]),
    );

    expect(await countRows("claim_rejections", "reason = 'archived'")).toBe(1);
    expect((await infer(alice)).skippedRejected).toBe(1);
  });
});

describe("evidence removal re-evaluates the inference", () => {
  it("withdraws an inference that falls below its own bar", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    expect((await inferredClaims())[0].status).toBe("active");

    // The user erases one of the statements it was inferred from.
    await db.sql.query(
      `DELETE FROM public.observations
       WHERE id = (SELECT observation_id FROM public.claim_evidence
                   WHERE relation = 'supports' ORDER BY occurred_at LIMIT 1)`,
    );

    const [claim] = await inferredClaims();
    // Automatic, not waiting for the user to notice and reject it.
    expect(claim.status).toBe("unsupported");
    expect(claim.valid_to).not.toBeNull();
    expect(claim.evidence_count).toBe(2);
  });

  it("does not withdraw a user-stated claim for the same reason", async () => {
    // A user claim needs one statement, so losing a restatement changes nothing.
    await seedConcept(alice);
    const statement = "User wants to build a tool around working memory.";
    for (const date of ["2026-01-01", "2026-01-20"]) {
      await statedClaim(alice, {
        text: "I want to build a tool around working memory.",
        excerpt: "build a tool around working memory",
        statement,
        statedAt: `${date}T00:00:00.000Z`,
      });
    }

    await db.sql.query(
      `DELETE FROM public.observations
       WHERE id = (SELECT observation_id FROM public.claim_evidence ORDER BY occurred_at LIMIT 1)`,
    );

    const { rows } = await db.sql.query<{ status: string }>(
      `SELECT status FROM public.user_claims WHERE asserted_by = 'user'`,
    );
    expect(rows[0].status).toBe("active");
  });

  it("reactivates a withdrawn inference when evidence returns", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    await db.sql.query(
      `DELETE FROM public.observations
       WHERE id = (SELECT observation_id FROM public.claim_evidence
                   WHERE relation = 'supports' ORDER BY occurred_at LIMIT 1)`,
    );
    expect((await inferredClaims())[0].status).toBe("unsupported");

    await statedClaim(alice, {
      text: "I want to keep working memory as my main focus.",
      excerpt: "keep working memory as my main focus",
      statement: "User wants to keep working memory as their main focus.",
      statedAt: "2026-04-01T00:00:00.000Z",
    });

    const summary = await infer(alice);
    expect(summary.claimsReactivated).toBe(1);
    const [claim] = await inferredClaims();
    expect(claim.status).toBe("active");
    expect(claim.valid_to).toBeNull();
  });

  it("does not reactivate a claim the user closed", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    const [claim] = await inferredClaims();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [claim.id]),
    );

    const summary = await infer(alice);
    expect(summary.claimsReactivated).toBe(0);
    expect((await inferredClaims())[0].status).toBe("retracted");
  });

  it("deletes the inference outright when all its evidence goes", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);

    await db.sql.query(`DELETE FROM public.observations WHERE event_type = 'claim_stated'`);
    expect(await countRows("user_claims")).toBe(0);
    expect(await countRows("claim_evidence")).toBe(0);
  });

  it("cannot exist without evidence at all", async () => {
    await expect(
      db.sql.exec(`
        BEGIN;
        INSERT INTO public.user_claims
          (user_id, claim_type, asserted_by, statement, canonical_key,
           inference_rule, inference_min_evidence, valid_from, first_stated_at, last_stated_at)
        VALUES ('${alice}', 'sustained_interest', 'cortex', 'User is into X.', 'sustained interest in x',
                'sustained_interest_v1', 3, NOW(), NOW(), NOW());
        COMMIT;
      `),
    ).rejects.toThrow(/no evidence/);
  });
});

describe("isolation", () => {
  it("never draws on another user's statements", async () => {
    await seedConcept(alice);
    await seedConcept(bob);
    await seedQualifyingEvidence(bob);

    expect((await infer(alice)).claimsCreated).toBe(0);
    expect((await infer(bob)).claimsCreated).toBe(1);
    expect(await countRows("user_claims", "asserted_by = 'cortex' AND user_id = $1", [alice])).toBe(0);
  });

  it("never shows one user another's inferences or refusals", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    const [claim] = await inferredClaims();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [claim.id]),
    );

    const visible = await db.asUser(bob, async () => ({
      claims: (await db.sql.query(`SELECT id FROM public.user_claims`)).rows.length,
      rejections: (await db.sql.query(`SELECT canonical_key FROM public.claim_rejections`)).rows.length,
    }));
    expect(visible).toEqual({ claims: 0, rejections: 0 });
  });

  it("keeps the inference pass out of reach of ordinary users", async () => {
    await expect(
      db.asUser(alice, () => db.sql.query(`SELECT public.infer_sustained_interest($1)`, [bob])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("runs the caller's own inference only", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await db.asUser(alice, () => db.sql.query(`SELECT public.refresh_my_inferences()`));
    expect(await countRows("user_claims", "asserted_by = 'cortex'")).toBe(1);
  });

  it("blocks forging a refusal", async () => {
    await expect(
      db.asUser(alice, () =>
        db.sql.query(
          `INSERT INTO public.claim_rejections (user_id, claim_type, canonical_key)
           VALUES ($1,'sustained_interest','x')`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("removes inferences and refusals with the account", async () => {
    await seedConcept(alice);
    await seedQualifyingEvidence(alice);
    await infer(alice);
    const [claim] = await inferredClaims();
    await db.asUser(alice, () =>
      db.sql.query(`SELECT public.close_user_claim($1,'retracted')`, [claim.id]),
    );

    await db.sql.query(`DELETE FROM auth.users WHERE id = $1`, [alice]);
    expect(await countRows("user_claims")).toBe(0);
    expect(await countRows("claim_rejections")).toBe(0);
  });
});
