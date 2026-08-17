/** A chunk as the concept stage sees it: stored text plus its durable identity. */
export type ConceptSourceChunk = {
  id: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
};

/**
 * One verified occurrence of a concept.
 *
 * Offsets are relative to `ConceptSourceChunk.content`, which is exactly what
 * `document_chunks.content` stores, so the span can always be checked against
 * the text that produced it.
 */
export type ConceptMentionCandidate = {
  chunkId: string;
  surfaceForm: string;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
};

/** A concept plus every span that grounds it. Never valid with zero mentions. */
export type ConceptCandidate = {
  label: string;
  canonicalKey: string;
  embedding?: number[];
  embeddingModel?: string;
  mentions: ConceptMentionCandidate[];
};

/** What the model returns before any verification. Treated as untrusted. */
export type RawExtractedConcept = {
  chunkIndex: number;
  label: string;
  surfaceForm: string;
};

export type ConceptSyncSummary = {
  conceptsCreated: number;
  conceptsMatchedExact: number;
  conceptsMatchedSemantic: number;
  /** Concepts that had no embedding until this run supplied one. */
  embeddingsBackfilled: number;
  mentionsWritten: number;
  /** New immutable `concept_encountered` observations. Zero on a re-ingest. */
  encountersRecorded: number;
  prunedConcepts: number;
  edges: number;
};
