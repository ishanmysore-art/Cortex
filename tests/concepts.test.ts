import { describe, expect, it } from "vitest";
import {
  MAX_CONCEPTS_PER_DOCUMENT,
  MAX_MENTIONS_PER_CONCEPT,
  buildExtractionInput,
  canonicalizeConceptLabel,
  groundConceptCandidates,
  isUnsupportedTemperatureError,
  normalizeConceptLabel,
  parseExtractionResponse,
  summarizeTopConcepts,
  type ConceptSourceChunk,
  type RawExtractedConcept,
} from "../lib/concepts";

const CHUNK_A: ConceptSourceChunk = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  chunkIndex: 0,
  content:
    "Working memory capacity predicts reading comprehension. ADHD participants showed reduced working memory span.",
  pageStart: 3,
  pageEnd: 3,
};

const CHUNK_B: ConceptSourceChunk = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  chunkIndex: 1,
  content: "The neural clock model explains temporal drift in time perception.",
  pageStart: 4,
  pageEnd: 5,
};

const CHUNKS = [CHUNK_A, CHUNK_B];

describe("canonicalizeConceptLabel", () => {
  it("collapses presentation differences into one identity", () => {
    const variants = [
      "Working Memory",
      "working  memory",
      "working-memory",
      "  Working memory  ",
      "working memory.",
    ];
    for (const variant of variants) {
      expect(canonicalizeConceptLabel(variant)).toBe("working memory");
    }
  });

  it("normalises diacritics and possessives", () => {
    expect(canonicalizeConceptLabel("naïve Bayes")).toBe("naive bayes");
    expect(canonicalizeConceptLabel("Bayes' theorem")).toBe("bayes theorem");
  });

  it("does not stem, so unrelated concepts cannot collide", () => {
    // Naive suffix stripping would turn both of these into prefixes that collide
    // with other words. A missed singular/plural split is the cheaper mistake.
    expect(canonicalizeConceptLabel("bias")).toBe("bias");
    expect(canonicalizeConceptLabel("analysis")).toBe("analysis");
  });
});

describe("normalizeConceptLabel", () => {
  it("accepts a real concept and returns both forms", () => {
    expect(normalizeConceptLabel("Attention Deficit Hyperactivity Disorder")).toEqual({
      label: "Attention Deficit Hyperactivity Disorder",
      canonicalKey: "attention deficit hyperactivity disorder",
    });
  });

  it("rejects values that are not ideas", () => {
    expect(normalizeConceptLabel("2024")).toBeNull();
    expect(normalizeConceptLabel("3.5")).toBeNull();
    expect(normalizeConceptLabel("%")).toBeNull();
  });

  it("rejects document furniture", () => {
    for (const term of ["Figure", "Table", "References", "Introduction", "Methods"]) {
      expect(normalizeConceptLabel(term)).toBeNull();
    }
  });

  it("rejects malformed or out-of-range input", () => {
    expect(normalizeConceptLabel(null)).toBeNull();
    expect(normalizeConceptLabel(42)).toBeNull();
    expect(normalizeConceptLabel("")).toBeNull();
    expect(normalizeConceptLabel("a")).toBeNull();
    expect(normalizeConceptLabel("x".repeat(200))).toBeNull();
  });
});

describe("parseExtractionResponse", () => {
  it("reads a well-formed response", () => {
    const items = parseExtractionResponse(
      JSON.stringify({ concepts: [{ chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" }] }),
    );
    expect(items).toEqual([{ chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" }]);
  });

  it("returns nothing rather than throwing on malformed output", () => {
    expect(parseExtractionResponse("not json")).toEqual([]);
    expect(parseExtractionResponse("")).toEqual([]);
    expect(parseExtractionResponse("{}")).toEqual([]);
    expect(parseExtractionResponse(JSON.stringify({ concepts: "nope" }))).toEqual([]);
  });

  it("drops individual entries with the wrong shape but keeps the rest", () => {
    const items = parseExtractionResponse(
      JSON.stringify({
        concepts: [
          { chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" },
          { chunkIndex: "zero", label: "bad", surfaceForm: "bad" },
          { label: "missing index", surfaceForm: "x" },
          null,
          { chunkIndex: 1.5, label: "fractional", surfaceForm: "x" },
        ],
      }),
    );
    expect(items).toHaveLength(1);
  });
});

describe("groundConceptCandidates", () => {
  it("anchors a concept to a span that can be verified against the chunk", () => {
    const { candidates } = groundConceptCandidates(
      [{ chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" }],
      CHUNKS,
    );

    expect(candidates).toHaveLength(1);
    const mention = candidates[0].mentions[0];
    expect(mention.chunkId).toBe(CHUNK_A.id);
    // The invariant the database also relies on.
    expect(CHUNK_A.content.slice(mention.charStart, mention.charEnd)).toBe(mention.surfaceForm);
    expect(mention.pageStart).toBe(3);
    expect(mention.pageEnd).toBe(3);
  });

  it("drops a concept whose surface form is not in the cited chunk", () => {
    // The hallucination filter: the model claims a term the passage never used.
    const { candidates, rejected } = groundConceptCandidates(
      [{ chunkIndex: 0, label: "dopamine transporter", surfaceForm: "dopamine transporter" }],
      CHUNKS,
    );
    expect(candidates).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("drops a mention attributed to the wrong chunk", () => {
    const { candidates, rejected } = groundConceptCandidates(
      // "neural clock model" exists, but in chunk 1, not chunk 0.
      [{ chunkIndex: 0, label: "neural clock model", surfaceForm: "neural clock model" }],
      CHUNKS,
    );
    expect(candidates).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("drops a mention pointing at a chunk that is not in the batch", () => {
    const { candidates, rejected } = groundConceptCandidates(
      [{ chunkIndex: 99, label: "working memory", surfaceForm: "Working memory" }],
      CHUNKS,
    );
    expect(candidates).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("stores the source text, not the model's echo of it", () => {
    const { candidates } = groundConceptCandidates(
      // The model lowercased what the passage capitalised.
      [{ chunkIndex: 0, label: "working memory", surfaceForm: "working Memory" }],
      CHUNKS,
    );
    expect(candidates[0].mentions[0].surfaceForm).toBe("Working memory");
  });

  it("merges surface variants of one concept into a single candidate", () => {
    const { candidates } = groundConceptCandidates(
      [
        { chunkIndex: 0, label: "Working Memory", surfaceForm: "Working memory" },
        { chunkIndex: 0, label: "working memory", surfaceForm: "working memory" },
      ],
      CHUNKS,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].canonicalKey).toBe("working memory");
    expect(candidates[0].mentions).toHaveLength(2);
    // Two occurrences, two distinct spans — never the same span counted twice.
    expect(candidates[0].mentions[0].charStart).not.toBe(candidates[0].mentions[1].charStart);
  });

  it("stops advancing once a repeated term is exhausted in a chunk", () => {
    const { candidates, rejected } = groundConceptCandidates(
      [
        { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
        { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
      ],
      CHUNKS,
    );
    expect(candidates[0].mentions).toHaveLength(1);
    expect(rejected).toBe(1);
  });

  it("keeps every candidate grounded in at least one mention", () => {
    const { candidates } = groundConceptCandidates(
      [
        { chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" },
        { chunkIndex: 0, label: "Figure", surfaceForm: "Working memory" },
        { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
      ],
      CHUNKS,
    );
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.mentions.length).toBeGreaterThan(0);
    }
  });

  it("orders candidates by how often the document returns to them", () => {
    const raw: RawExtractedConcept[] = [
      { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
      { chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" },
      { chunkIndex: 0, label: "working memory", surfaceForm: "working memory" },
    ];
    const { candidates } = groundConceptCandidates(raw, CHUNKS);
    expect(candidates[0].canonicalKey).toBe("working memory");
  });

  it("bounds concepts per document and mentions per concept", () => {
    const many: RawExtractedConcept[] = [];
    for (let index = 0; index < MAX_CONCEPTS_PER_DOCUMENT + 20; index += 1) {
      many.push({ chunkIndex: 0, label: `concept number ${index}`, surfaceForm: "Working memory" });
    }
    for (let index = 0; index < MAX_MENTIONS_PER_CONCEPT + 10; index += 1) {
      many.push({ chunkIndex: 0, label: "working memory", surfaceForm: "working memory" });
    }

    const { candidates } = groundConceptCandidates(many, CHUNKS);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CONCEPTS_PER_DOCUMENT);
    for (const candidate of candidates) {
      expect(candidate.mentions.length).toBeLessThanOrEqual(MAX_MENTIONS_PER_CONCEPT);
    }
  });

  it("produces the same result for the same input", () => {
    const raw: RawExtractedConcept[] = [
      { chunkIndex: 0, label: "Working Memory", surfaceForm: "Working memory" },
      { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
    ];
    expect(groundConceptCandidates(raw, CHUNKS)).toEqual(groundConceptCandidates(raw, CHUNKS));
  });

  it("returns nothing for empty input rather than failing", () => {
    expect(groundConceptCandidates([], CHUNKS)).toEqual({ candidates: [], rejected: 0 });
    expect(groundConceptCandidates([{ chunkIndex: 0, label: "x", surfaceForm: "y" }], [])).toEqual({
      candidates: [],
      rejected: 1,
    });
  });
});

describe("extraction plumbing", () => {
  it("labels each passage so the model can attribute a concept to one chunk", () => {
    const input = buildExtractionInput(CHUNKS, "paper.pdf");
    expect(input).toContain("Document: paper.pdf");
    expect(input).toContain("[CHUNK 0]");
    expect(input).toContain("[CHUNK 1]");
    expect(input).toContain(CHUNK_B.content);
  });

  it("recognises only a genuine unsupported-temperature failure", () => {
    expect(
      isUnsupportedTemperatureError(new Error("Unsupported parameter: 'temperature' is not supported")),
    ).toBe(true);
    expect(isUnsupportedTemperatureError(new Error("rate limit exceeded"))).toBe(false);
    expect(isUnsupportedTemperatureError(new Error("temperature is fine"))).toBe(false);
  });

  it("summarises top concepts within the observation payload budget", () => {
    const { candidates } = groundConceptCandidates(
      [
        { chunkIndex: 0, label: "working memory", surfaceForm: "Working memory" },
        { chunkIndex: 0, label: "working memory", surfaceForm: "working memory" },
        { chunkIndex: 1, label: "neural clock model", surfaceForm: "neural clock model" },
      ],
      CHUNKS,
    );
    const summary = summarizeTopConcepts(candidates);
    expect(summary[0]).toBe("working memory");
    expect(summary).toContain("neural clock model");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(8_000);
  });
});
