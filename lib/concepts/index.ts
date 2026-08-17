/**
 * The concept layer.
 *
 * Extraction is untrusted and always verified against stored chunk text before
 * anything is persisted; see `groundConceptCandidates`.
 */
export {
  MAX_CONCEPT_LABEL_CHARS,
  MIN_CONCEPT_LABEL_CHARS,
  canonicalizeConceptLabel,
  isStructuralTerm,
  normalizeConceptLabel,
  type NormalizedConceptLabel,
} from "@/lib/concepts/canonical";

export {
  CONCEPT_CHUNK_BATCH_SIZE,
  CONCEPT_EXTRACTION_INSTRUCTIONS,
  CONCEPT_EXTRACTION_SCHEMA,
  CONCEPT_PROMPT_VERSION,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CONCEPTS_PER_DOCUMENT,
  MAX_MENTIONS_PER_CONCEPT,
  buildExtractionInput,
  conceptModel,
  extractConceptCandidates,
  groundConceptCandidates,
  isUnsupportedTemperatureError,
  parseExtractionResponse,
  type ExtractionResult,
} from "@/lib/concepts/extractor";

export {
  MAX_ATTRIBUTED_CONCEPTS,
  attachConceptAttribution,
} from "@/lib/concepts/attribution";

export {
  CONCEPT_SIMILARITY_THRESHOLD,
  embedConceptCandidates,
  loadConceptSourceChunks,
  summarizeTopConcepts,
  syncDocumentConcepts,
  type ConceptSyncResult,
} from "@/lib/concepts/sync";

export type {
  ConceptCandidate,
  ConceptMentionCandidate,
  ConceptSourceChunk,
  ConceptSyncSummary,
  RawExtractedConcept,
} from "@/lib/concepts/types";
