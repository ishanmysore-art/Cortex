/**
 * Explicit user claims.
 *
 * Everything here concerns what the user *said*. Nothing infers, and the
 * deterministic guards in `grounding.ts` are what keep it that way.
 */
export {
  CLAIM_STATUSES,
  CLAIM_TYPES,
  EXTRACTABLE_CLAIM_TYPES,
  INFERRED_CLAIM_TYPES,
  SUSTAINED_INTEREST_MIN_CLAIMS,
  SUSTAINED_INTEREST_MIN_SPAN_DAYS,
  MAX_CLAIMS_PER_MESSAGE,
  MAX_CLAIM_EXCERPT_CHARS,
  MAX_CLAIM_STATEMENT_CHARS,
  MIN_CLAIM_STATEMENT_CHARS,
  emptyRejections,
  isClaimType,
  isExtractableClaimType,
  isInferredClaimType,
  type ClaimCandidate,
  type ClaimEvidenceRecord,
  type ClaimExtractionResult,
  type ClaimRejectionReason,
  type ClaimStatus,
  type ClaimSyncSummary,
  type ClaimType,
  type RawClaimCandidate,
  type UserClaim,
} from "@/lib/claims/types";

export {
  canonicalizeClaimStatement,
  normalizeClaimStatement,
  type NormalizedClaimStatement,
} from "@/lib/claims/canonical";

export {
  containingSentence,
  hasReportedSpeechMarker,
  hasStanceMarker,
  locateExcerpt,
  sentenceSpans,
} from "@/lib/claims/grounding";

export {
  CLAIM_EXTRACTION_INSTRUCTIONS,
  CLAIM_EXTRACTION_SCHEMA,
  CLAIM_PROMPT_VERSION,
  claimModel,
  extractClaimCandidates,
  groundClaimCandidates,
  isUnsupportedTemperatureError,
  parseClaimResponse,
} from "@/lib/claims/extractor";

export {
  embedClaimCandidates,
  syncMessageClaims,
  type ClaimSyncResult,
} from "@/lib/claims/sync";

export {
  listClaimEvidence,
  listUserClaims,
  refreshInferences,
  toUserClaim,
} from "@/lib/claims/queries";
