import { describe, expect, it } from "vitest";
import {
  CLAIM_TYPES,
  EXTRACTABLE_CLAIM_TYPES,
  MAX_CLAIMS_PER_MESSAGE,
  INFERRED_CLAIM_TYPES,
  canonicalizeClaimStatement,
  containingSentence,
  groundClaimCandidates,
  hasReportedSpeechMarker,
  hasStanceMarker,
  isClaimType,
  isExtractableClaimType,
  isInferredClaimType,
  locateExcerpt,
  normalizeClaimStatement,
  parseClaimResponse,
  type RawClaimCandidate,
} from "../lib/claims";

/** Convenience: run the grounding guards over one proposed claim. */
function ground(message: string, candidate: Partial<RawClaimCandidate> = {}) {
  return groundClaimCandidates(
    [
      {
        claimType: candidate.claimType ?? "belief",
        statement: candidate.statement ?? "User thinks something.",
        excerpt: candidate.excerpt ?? message,
      },
    ],
    message,
  );
}

describe("claim taxonomy", () => {
  it("contains no psychological category Cortex would have to infer", () => {
    // The scope boundary of this milestone, enforced rather than documented.
    const forbidden =
      /(personality|learning[_ ]?style|trait|disorder|adhd|depress|anxiety|diagnos|iq|neuroti|introvert|extrovert)/i;
    for (const type of CLAIM_TYPES) {
      expect(type).not.toMatch(forbidden);
    }
  });

  it("keeps the migration-only category out of extraction", () => {
    // `note` exists so legacy memories are not mislabelled with a guessed
    // category. Guessing one would be an inference.
    expect(isClaimType("note")).toBe(true);
    expect(isExtractableClaimType("note")).toBe(false);
    expect(EXTRACTABLE_CLAIM_TYPES).not.toContain("note");
  });

  it("keeps the one inferred category out of extraction", () => {
    // `sustained_interest` is asserted by Cortex from evidence the user supplied.
    // The extractor must never produce it, or an inference would masquerade as
    // something the user said.
    expect(isClaimType("sustained_interest")).toBe(true);
    expect(isExtractableClaimType("sustained_interest")).toBe(false);
    expect(isInferredClaimType("sustained_interest")).toBe(true);
    expect(isInferredClaimType("belief")).toBe(false);
    expect(EXTRACTABLE_CLAIM_TYPES).not.toContain("sustained_interest");
  });

  it("describes what the user said, never a psychological attribute", () => {
    // Restated for the inferred category specifically: it reports recurrence of
    // explicit statements, not a latent trait.
    for (const type of INFERRED_CLAIM_TYPES) {
      expect(CLAIM_TYPES).toContain(type);
      expect(type).not.toMatch(
        /(personality|learning[_ ]?style|trait|disorder|adhd|depress|anxiety|diagnos|iq|neuroti|introvert|extrovert|mastery|forget)/i,
      );
    }
  });

  it("recognises only known types", () => {
    expect(isClaimType("belief")).toBe(true);
    expect(isClaimType("visual_learner")).toBe(false);
    expect(isClaimType(7)).toBe(false);
  });
});

describe("canonicalisation", () => {
  it("collapses presentation differences only", () => {
    expect(canonicalizeClaimStatement("User thinks Retrieval is  insufficient.")).toBe(
      "user thinks retrieval is insufficient",
    );
    expect(canonicalizeClaimStatement("User's goal is X")).toBe("users goal is x");
  });

  it("never collapses a statement with its negation", () => {
    // The single most important thing canonicalisation must not do.
    const held = canonicalizeClaimStatement("User thinks AI should augment human reasoning.");
    const dropped = canonicalizeClaimStatement(
      "User no longer thinks AI should augment human reasoning.",
    );
    expect(held).not.toBe(dropped);
  });

  it("rejects statements that carry no content", () => {
    expect(normalizeClaimStatement("")).toBeNull();
    expect(normalizeClaimStatement("42")).toBeNull();
    expect(normalizeClaimStatement("x".repeat(600))).toBeNull();
    expect(normalizeClaimStatement(null)).toBeNull();
  });
});

describe("stance and reported-speech guards", () => {
  it("recognises the user speaking for themselves", () => {
    for (const sentence of [
      "I think transformers are easier to reason about.",
      "I want to build Cortex into something that models how people think.",
      "I'm interested in cognitive architectures.",
      "I'm trying to understand attention.",
      "I suspect retrieval is overrated.",
      "In my view synthesis matters more.",
      "My goal is to ship this by spring.",
      "I'd prefer a simpler design.",
      "I'm a researcher.",
    ]) {
      expect(hasStanceMarker(sentence)).toBe(true);
    }
  });

  it("does not treat a bare fact or a question as a stance", () => {
    for (const sentence of [
      "Transformers are used in ChatGPT.",
      "What's the difference between transformers and RNNs?",
      "Retrieval practice improves memory.",
      "The results were significant.",
    ]) {
      expect(hasStanceMarker(sentence)).toBe(false);
    }
  });

  it("recognises a sentence that relays someone else's view", () => {
    for (const sentence of [
      "I read a paper arguing that retrieval practice improves memory.",
      "According to the docs, this is deprecated.",
      "The author claims that scaling is all you need.",
      "They say attention is quadratic.",
      "I came across a post about this.",
    ]) {
      expect(hasReportedSpeechMarker(sentence)).toBe(true);
    }
  });

  it("locates the sentence surrounding a span", () => {
    const message = "Transformers are common. I think they are simpler. What do you think?";
    const span = locateExcerpt(message, "they are simpler")!;
    expect(containingSentence(message, span.charStart, span.charEnd)).toContain("I think");
  });
});

describe("groundClaimCandidates — the epistemic boundary", () => {
  it("accepts an explicit belief", () => {
    const message = "I think retrieval alone isn't enough for a second brain.";
    const { candidates } = ground(message, {
      claimType: "belief",
      statement: "User thinks retrieval alone is insufficient for a second brain.",
      excerpt: "retrieval alone isn't enough for a second brain",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].claimType).toBe("belief");
    // The span must be verifiable against the message.
    expect(message.slice(candidates[0].charStart, candidates[0].charEnd)).toBe(
      candidates[0].excerpt,
    );
  });

  it("accepts an explicit goal", () => {
    const message = "I want to build Cortex into something that models how people think.";
    const { candidates } = ground(message, {
      claimType: "goal",
      statement: "User wants to build Cortex into something that models how people think.",
      excerpt: "build Cortex into something that models how people think",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].claimType).toBe("goal");
  });

  it("accepts an explicit interest", () => {
    const message = "I'm interested in systems that model cognition.";
    const { candidates } = ground(message, {
      claimType: "interest",
      statement: "User is interested in systems that model cognition.",
      excerpt: "systems that model cognition",
    });
    expect(candidates).toHaveLength(1);
  });

  it("accepts a stated learning intention as an open question", () => {
    const message = "I'm trying to understand transformers.";
    const { candidates } = ground(message, {
      claimType: "open_question",
      statement: "User is trying to understand transformers.",
      excerpt: "trying to understand transformers",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].claimType).toBe("open_question");
  });

  it("produces nothing for an ordinary question", () => {
    // Even if the model proposes a claim, no stance marker means no claim.
    const message = "What's the difference between transformers and RNNs?";
    const { candidates, rejections } = ground(message, {
      excerpt: "difference between transformers and RNNs",
    });
    expect(candidates).toHaveLength(0);
    expect(rejections.no_stance_marker).toBe(1);
  });

  it("does not turn a statement of fact into a belief", () => {
    const message = "Transformers are used in ChatGPT.";
    const { candidates, rejections } = ground(message, { excerpt: "Transformers are used in ChatGPT" });
    expect(candidates).toHaveLength(0);
    expect(rejections.no_stance_marker).toBe(1);
  });

  it("does not turn something the user read into something they believe", () => {
    // The central case this milestone must never get wrong.
    const message = "I read a paper arguing that retrieval practice improves memory.";
    const { candidates, rejections } = ground(message, {
      statement: "User believes retrieval practice improves memory.",
      excerpt: "retrieval practice improves memory",
    });
    expect(candidates).toHaveLength(0);
    expect(rejections.reported_speech).toBe(1);
  });

  it("does not turn a cited external opinion into a user position", () => {
    const message = "According to the author, scaling is all you need.";
    const { candidates, rejections } = ground(message, { excerpt: "scaling is all you need" });
    expect(candidates).toHaveLength(0);
    expect(rejections.reported_speech).toBe(1);
  });

  it("still accepts the user's own view stated in a separate sentence", () => {
    const message =
      "I read a paper arguing that retrieval practice improves memory. I think synthesis matters more.";
    const { candidates } = ground(message, {
      statement: "User thinks synthesis matters more than retrieval practice.",
      excerpt: "synthesis matters more",
    });
    expect(candidates).toHaveLength(1);
  });

  it("abstains when the model returns nothing", () => {
    const { candidates } = groundClaimCandidates([], "I think X.");
    expect(candidates).toHaveLength(0);
  });

  it("rejects a hallucinated span", () => {
    const message = "I think transformers are easier to reason about.";
    const { candidates, rejections } = ground(message, {
      excerpt: "recurrent networks are hopeless",
    });
    expect(candidates).toHaveLength(0);
    expect(rejections.span_not_found).toBe(1);
  });

  it("rejects a span taken from a different message", () => {
    const written = "I think transformers are easier to reason about.";
    const otherMessage = "I want to learn about diffusion models.";
    const { candidates, rejections } = groundClaimCandidates(
      [
        {
          claimType: "goal",
          statement: "User wants to learn about diffusion models.",
          excerpt: "learn about diffusion models",
        },
      ],
      written,
    );
    expect(otherMessage).toContain("learn about diffusion models");
    expect(candidates).toHaveLength(0);
    expect(rejections.span_not_found).toBe(1);
  });

  it("rejects an unknown claim type", () => {
    const message = "I think transformers are easier to reason about.";
    const { candidates, rejections } = ground(message, {
      claimType: "visual_learner",
      excerpt: "transformers are easier to reason about",
    });
    expect(candidates).toHaveLength(0);
    expect(rejections.unknown_type).toBe(1);
  });

  it("rejects a malformed statement or excerpt", () => {
    const message = "I think transformers are easier to reason about.";
    expect(
      ground(message, { statement: "", excerpt: "transformers are easier" }).rejections
        .invalid_statement,
    ).toBe(1);
    expect(
      ground(message, { excerpt: "   " }).rejections.invalid_excerpt,
    ).toBe(1);
  });

  it("stores the user's own words, not the model's echo of them", () => {
    const message = "I think Retrieval Alone is insufficient.";
    const { candidates } = ground(message, { excerpt: "retrieval alone" });
    expect(candidates[0].excerpt).toBe("Retrieval Alone");
  });

  it("deduplicates identical claims within one message", () => {
    const message = "I think retrieval is overrated. I think retrieval is overrated.";
    const { candidates } = groundClaimCandidates(
      [
        { claimType: "belief", statement: "User thinks retrieval is overrated.", excerpt: "retrieval is overrated" },
        { claimType: "belief", statement: "User thinks retrieval is overrated.", excerpt: "retrieval is overrated" },
      ],
      message,
    );
    expect(candidates).toHaveLength(1);
  });

  it("keeps distinct claims distinct", () => {
    const message = "I think retrieval is overrated and I want to build a synthesis engine.";
    const { candidates } = groundClaimCandidates(
      [
        { claimType: "belief", statement: "User thinks retrieval is overrated.", excerpt: "retrieval is overrated" },
        { claimType: "goal", statement: "User wants to build a synthesis engine.", excerpt: "build a synthesis engine" },
      ],
      message,
    );
    expect(candidates).toHaveLength(2);
  });

  it("bounds how much one message can contribute", () => {
    const message = `I think ${Array.from({ length: 20 }, (_, i) => `point ${i}`).join(", ")}.`;
    const raw: RawClaimCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      claimType: "belief",
      statement: `User thinks point ${i} matters.`,
      excerpt: `point ${i}`,
    }));
    const { candidates } = groundClaimCandidates(raw, message);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_MESSAGE);
  });

  it("is deterministic", () => {
    const message = "I think retrieval is overrated.";
    const raw: RawClaimCandidate[] = [
      { claimType: "belief", statement: "User thinks retrieval is overrated.", excerpt: "retrieval is overrated" },
    ];
    expect(groundClaimCandidates(raw, message)).toEqual(groundClaimCandidates(raw, message));
  });
});

describe("parseClaimResponse", () => {
  it("reads a well-formed response", () => {
    expect(
      parseClaimResponse(
        JSON.stringify({ claims: [{ claimType: "belief", statement: "User thinks X.", excerpt: "X" }] }),
      ),
    ).toHaveLength(1);
  });

  it("treats an empty list as a valid abstention", () => {
    expect(parseClaimResponse(JSON.stringify({ claims: [] }))).toEqual([]);
  });

  it("never throws on malformed output", () => {
    expect(parseClaimResponse("not json")).toEqual([]);
    expect(parseClaimResponse("")).toEqual([]);
    expect(parseClaimResponse("{}")).toEqual([]);
    expect(parseClaimResponse(JSON.stringify({ claims: "nope" }))).toEqual([]);
  });

  it("drops individual malformed entries and keeps the rest", () => {
    const items = parseClaimResponse(
      JSON.stringify({
        claims: [
          { claimType: "belief", statement: "User thinks X.", excerpt: "X" },
          { claimType: 5, statement: "bad", excerpt: "bad" },
          { statement: "missing type", excerpt: "x" },
          null,
        ],
      }),
    );
    expect(items).toHaveLength(1);
  });
});
