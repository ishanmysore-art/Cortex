import { describe, expect, it } from "vitest";
import { buildEmbeddingInputText } from "../lib/ingestion/processor";
import {
  buildEvidenceSection,
  buildPromptCacheKey,
  buildAskInput,
  buildRetrievalQueries,
  buildVerificationInput,
  citedSources,
  isComprehensiveDatasetQuery,
  isEvidenceAuditQuestion,
  isExactReproductionRequest,
  mergeEvidenceSources,
  selectDiverseChunks,
  type RetrievedSource,
  validateGroundedAnswer,
} from "../lib/rag/retrieval";

describe("RAG Retrieval & Multi-Document Selection", () => {
  describe("prompt cache keys", () => {
    it("stays within OpenAI's 64-character limit while remaining deterministic", () => {
      const conversationId = "123e4567-e89b-12d3-a456-426614174000";
      const draftKey = buildPromptCacheKey("draft", conversationId);
      const verifyKey = buildPromptCacheKey("verify", conversationId);

      expect(draftKey).toBe(buildPromptCacheKey("draft", conversationId));
      expect(verifyKey).toBe(buildPromptCacheKey("verify", conversationId));
      expect(draftKey.length).toBeLessThanOrEqual(64);
      expect(verifyKey.length).toBeLessThanOrEqual(64);
    });
  });

  describe("buildEmbeddingInputText", () => {
    it("formats embedding input with document title and mime type without altering raw content", () => {
      const title = "ADHD Research Paper.pdf";
      const mimeType = "application/pdf";
      const rawContent = "Neural clock simulations indicate non-linear drift in time perception.";

      const textToEmbed = buildEmbeddingInputText(title, mimeType, rawContent);

      expect(textToEmbed).toContain("Document Title: ADHD Research Paper.pdf (application/pdf)");
      expect(textToEmbed).toContain(rawContent);
      // Raw content itself remains isolated below header
      expect(textToEmbed.endsWith(rawContent)).toBe(true);
    });
  });

  describe("Milestone 7.5 traceability safeguards", () => {
    const evidence: RetrievedSource[] = [{
      id: "chunk-metrics",
      document_id: "doc-adhd",
      chunk_index: 7,
      content: "Recall: 70.5%. Recall: 96.8%. Accuracy: 97.0%.",
      similarity: 0.92,
      document_title: "ADHD paper.pdf",
      document_file_type: "pdf",
      page_start: 7,
      page_end: 7,
    }];

    it("detects broad dataset inventories and adds a targeted semantic query", () => {
      const question = "Identify every dataset used anywhere in my ADHD paper and do not omit datasets.";
      expect(isComprehensiveDatasetQuery(question)).toBe(true);
      expect(buildRetrievalQueries(question)).toHaveLength(2);
      expect(buildRetrievalQueries("What was the adult classification dataset?")).toHaveLength(1);
    });

    it("recognizes evidence-audit follow-ups", () => {
      expect(isEvidenceAuditQuestion("For every factual claim in your previous answer, identify the source.")).toBe(true);
      expect(isEvidenceAuditQuestion("What were the final performance metrics?")).toBe(false);
    });

    it("reattaches prior evidence with stable provenance", () => {
      const prior = [{ ...evidence[0], content: "Accuracy: 97.0% [prior answer evidence]" }];
      const merged = mergeEvidenceSources(evidence, prior);
      expect(merged[0]).toMatchObject({ id: "chunk-metrics", page_start: 7 });
      expect(merged).toHaveLength(1);
    });

    it("adds exact-reproduction constraints and rejects derived quantities", () => {
      const question = "Reproduce the classification-results table exactly as reported. Do not calculate any new values.";
      expect(isExactReproductionRequest(question)).toBe(true);
      expect(buildAskInput({ history: [], memories: [], sources: evidence, question })).toContain("STRICT EXACT-REPRODUCTION MODE");
      expect(validateGroundedAnswer("Recall was 37% higher [1].", evidence, question)).toMatchObject({
        valid: false,
        reason: "derived-quantity",
      });
      expect(validateGroundedAnswer("The result improved by more than threefold [1].", evidence, question)).toMatchObject({
        valid: false,
        reason: "derived-quantity",
      });
      expect(validateGroundedAnswer("Recall: 70.5% [1].", evidence, question)).toEqual({ valid: true });
    });

    it("includes previous evidence in the audit prompt without needing raw documents", () => {
      const prompt = buildAskInput({
        history: [{ role: "assistant", content: "Accuracy: 97.0% [1]." }],
        memories: [],
        sources: evidence,
        priorEvidence: [{ ...evidence[0], content: "Accuracy: 97.0%" }],
        question: "Where did each number in your previous answer come from?",
      });
      expect(prompt).toContain("Evidence attached to previous assistant answers");
      expect(prompt).toContain("Chunk ID: chunk-metrics");
    });
  });

  describe("selectDiverseChunks", () => {
    const mockSources: RetrievedSource[] = [
      {
        id: "chunk-adhd-1",
        document_id: "doc-adhd",
        chunk_index: 0,
        content: "ADHD neural-clock paper introduction...",
        similarity: 0.85,
        document_title: "Detecting ADHD from Neural Clock Simulations.pdf",
        document_file_type: "pdf",
        page_start: 1,
        page_end: 2,
      },
      {
        id: "chunk-adhd-2",
        document_id: "doc-adhd",
        chunk_index: 1,
        content: "Simulating cortical oscillator networks...",
        similarity: 0.82,
        document_title: "Detecting ADHD from Neural Clock Simulations.pdf",
        document_file_type: "pdf",
        page_start: 3,
        page_end: 4,
      },
      {
        id: "chunk-islp-1",
        document_id: "doc-islp",
        chunk_index: 0,
        content: "ISLP Chapter 9: Support Vector Machines and maximal margin classifiers...",
        similarity: 0.78,
        document_title: "ISLP Chapter 9.pdf",
        document_file_type: "pdf",
        page_start: 335,
        page_end: 340,
      },
      {
        id: "chunk-islp-2",
        document_id: "doc-islp",
        chunk_index: 1,
        content: "Non-linear decision boundaries using radial kernel SVMs...",
        similarity: 0.75,
        document_title: "ISLP Chapter 9.pdf",
        document_file_type: "pdf",
        page_start: 341,
        page_end: 345,
      },
      {
        id: "chunk-usaypt-1",
        document_id: "doc-usaypt",
        chunk_index: 0,
        content: "USAYPT Presentation Script for physics competition...",
        similarity: 0.70,
        document_title: "USAYPT Presentation Script.pdf",
        document_file_type: "pdf",
        page_start: 1,
        page_end: 1,
      },
    ];

    it("returns empty array when no candidates exist", () => {
      expect(selectDiverseChunks([], "test question", 20)).toEqual([]);
    });

    it("handles single-document queries correctly", () => {
      const singleDocSources = mockSources.filter((s) => s.document_id === "doc-adhd");
      const selected = selectDiverseChunks(singleDocSources, "Tell me about ADHD neural clocks", 20);

      expect(selected.length).toBe(2);
      expect(selected.every((s) => s.document_id === "doc-adhd")).toBe(true);
    });

    it("prioritizes explicitly named documents in queries", () => {
      const query = "Compare my ADHD paper with concepts in ISLP Chapter 9";
      const selected = selectDiverseChunks(mockSources, query, 20);

      const docIds = new Set(selected.map((s) => s.document_id));
      expect(docIds.has("doc-adhd")).toBe(true);
      expect(docIds.has("doc-islp")).toBe(true);
    });

    it("balances multi-document chunks and respects the target limit", () => {
      const limit = 3;
      const selected = selectDiverseChunks(mockSources, "Overview of all papers", limit);

      expect(selected.length).toBe(limit);
      // Ensures results are sorted by similarity descending
      expect(selected[0].similarity).toBeGreaterThanOrEqual(selected[1].similarity);
      expect(selected[1].similarity).toBeGreaterThanOrEqual(selected[2].similarity);
    });
  });

  describe("citation correctness", () => {
    const sources: RetrievedSource[] = [
      {
        id: "c1",
        document_id: "d1",
        chunk_index: 0,
        content: "Excerpt one content",
        similarity: 0.9,
        document_title: "Doc 1.pdf",
        document_file_type: "pdf",
        page_start: 1,
        page_end: 1,
      },
      {
        id: "c2",
        document_id: "d2",
        chunk_index: 0,
        content: "Excerpt two content",
        similarity: 0.8,
        document_title: "Doc 2.pdf",
        document_file_type: "pdf",
        page_start: 5,
        page_end: 6,
      },
    ];

    it("accurately maps citation markers to retrieved sources", () => {
      const answer = "Neural clock drift is significant [1], while SVMs create non-linear boundaries [2].";
      const citations = citedSources(answer, sources);

      expect(citations).toHaveLength(2);
      expect(citations[0]).toMatchObject({
        citationIndex: 1,
        source: expect.objectContaining({ id: "c1", document_title: "Doc 1.pdf" }),
      });
      expect(citations[1]).toMatchObject({
        citationIndex: 2,
        source: expect.objectContaining({ id: "c2", document_title: "Doc 2.pdf" }),
      });
    });

    it("ignores out-of-range or invalid citation markers", () => {
      const answer = "Claim with invalid citation [99] and non-numeric [abc].";
      const citations = citedSources(answer, sources);

      expect(citations).toHaveLength(0);
    });
  });

  describe("evidence grounding regression checks", () => {
    const sources: RetrievedSource[] = [
      {
        id: "adhd-results",
        document_id: "adhd-paper",
        chunk_index: 6,
        content: "This study investigates whether neural-clock simulations can detect ADHD. The experiment uses an ADHD dataset. The CNN-GRU model optimized with Bayesian optimization achieved 97.0% accuracy on that dataset. No medication effectiveness outcomes were evaluated.",
        similarity: 0.95,
        document_title: "Detecting ADHD from Neural Clock Simulations.pdf",
        document_file_type: "pdf",
        page_start: 6,
        page_end: 6,
      },
    ];

    it("keeps document, page, chunk, and content together in model evidence", () => {
      const evidence = buildEvidenceSection(sources);
      expect(evidence).toContain("SOURCE 1");
      expect(evidence).toContain("Document: Detecting ADHD from Neural Clock Simulations.pdf");
      expect(evidence).toContain("Page: 6");
      expect(evidence).toContain("Chunk ID: adhd-results");
      expect(evidence).toContain(sources[0].content);
    });

    it("provides the same structured evidence to the verification pass", () => {
      const input = buildVerificationInput({
        question: "What were the final performance metrics?",
        draft: "The model achieved 97.0% accuracy [1].",
        sources,
      });
      expect(input).toContain("Draft answer to verify:");
      expect(input).toContain("SOURCE 1");
    });

    it("accepts explicitly supported numerical claims", () => {
      expect(validateGroundedAnswer("The CNN-GRU model achieved 97.0% accuracy [1].", sources)).toEqual({ valid: true });
    });

    it("rejects a numerical mismatch instead of allowing model/metric/value guessing", () => {
      expect(validateGroundedAnswer("The CNN-GRU model achieved 97.9% accuracy [1].", sources)).toMatchObject({
        valid: false,
        reason: "unsupported-number",
      });
    });

    it("rejects fabricated source references", () => {
      expect(validateGroundedAnswer("The study used SVMs [2].", sources)).toMatchObject({
        valid: false,
        reason: "invalid-citation",
      });
    });

    it("allows abstention when no evidence establishes an answer", () => {
      expect(validateGroundedAnswer("I couldn't find evidence for this in the documents you've provided.", sources)).toEqual({ valid: true });
    });

    it("covers the existing ADHD benchmark categories without adding question-specific runtime logic", () => {
      const benchmark = [
        {
          question: "What is the central research question of my ADHD neural-clock paper?",
          answer: "The paper investigates whether neural-clock simulations can detect ADHD [1].",
        },
        {
          question: "What dataset did I use in my ADHD research?",
          answer: "The reported experiment uses an ADHD dataset [1].",
        },
        {
          question: "What were the final performance metrics reported for my ADHD model?",
          answer: "The CNN-GRU model achieved 97.0% accuracy on the ADHD dataset [1].",
        },
        {
          question: "List every quantitative claim related to model performance.",
          answer: "The cited passage reports 97.0% accuracy [1].",
        },
        {
          question: "Does my ADHD paper actually use Bayesian optimization?",
          answer: "Yes. It explicitly says the CNN-GRU model was optimized with Bayesian optimization [1].",
        },
        {
          question: "Does my ADHD paper actually use SVMs?",
          answer: "I couldn't find evidence for this in the documents you've provided.",
        },
        {
          question: "What did my ADHD study find about medication effectiveness?",
          answer: "I couldn't find evidence for this in the documents you've provided.",
        },
        {
          question: "What was my favorite machine-learning framework?",
          answer: "I couldn't find evidence for this in the documents you've provided.",
        },
      ];

      for (const entry of benchmark) {
        expect(entry.question).not.toHaveLength(0);
        expect(validateGroundedAnswer(entry.answer, sources)).toEqual({ valid: true });
      }
    });
  });
});
