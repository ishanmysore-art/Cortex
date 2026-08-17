/**
 * The explicit-claim taxonomy.
 *
 * Every category here describes something the user SAID about their own
 * thinking. None of them is a psychological attribute, a trait, or anything
 * Cortex worked out on its own — that boundary is the entire point of this
 * milestone and is enforced by tests.
 *
 * `position` from the original sketch is deliberately absent: in practice it is
 * indistinguishable from `belief`, and a category that forces an arbitrary
 * choice produces noise rather than structure.
 */

export const CLAIM_TYPES = [
  /** "I think X" — a view the user holds about how something is. */
  "belief",
  /** "I want to X", "I'm building X" — something the user is trying to bring about. */
  "goal",
  /** "I'm interested in X", "I care about X" — a stated pull toward a subject. */
  "interest",
  /** "I prefer X over Y" — a stated preference between options. */
  "preference",
  /** "I'm trying to understand X", "I keep wondering whether X" — a question the user holds. */
  "open_question",
  /** "I suspect X" — the user's own tentative idea, stated as tentative. */
  "hypothesis",
  /** "I'm a researcher", "I'm new to this" — an explicit statement about themselves. */
  "self_description",
  /**
   * An explicit statement the user asked Cortex to remember whose category has
   * not been determined. Only produced by the legacy `memories` migration, never
   * by extraction: guessing a category would be an inference, and mislabelling
   * is worse than declining to label.
   */
  "note",
  /**
   * The only category Cortex asserts itself: the user has repeatedly and
   * independently said they are working on or trying to understand something.
   *
   * It is a synthesis of explicit claims, not a psychological attribute — the
   * statement is about what the user said, and every occasion is cited.
   * Produced only by `infer_sustained_interest`, never by extraction.
   */
  "sustained_interest",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Categories that come from a user's own words. `note` is migration-only. */
const NON_EXTRACTABLE = new Set<string>(["note", "sustained_interest"]);

export const EXTRACTABLE_CLAIM_TYPES = CLAIM_TYPES.filter(
  (type) => !NON_EXTRACTABLE.has(type),
) as Exclude<ClaimType, "note" | "sustained_interest">[];

/** Categories only Cortex produces, from evidence the user supplied. */
export const INFERRED_CLAIM_TYPES = ["sustained_interest"] as const;

export function isClaimType(value: unknown): value is ClaimType {
  return typeof value === "string" && (CLAIM_TYPES as readonly string[]).includes(value);
}

export function isExtractableClaimType(value: unknown): value is ClaimType {
  return isClaimType(value) && !NON_EXTRACTABLE.has(value);
}

export function isInferredClaimType(value: unknown): value is ClaimType {
  return typeof value === "string" && (INFERRED_CLAIM_TYPES as readonly string[]).includes(value);
}

export const CLAIM_STATUSES = [
  "active",
  "archived",
  "retracted",
  "superseded",
  /** System withdrawal: an inference fell below the bar it was created under. */
  "unsupported",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const MAX_CLAIM_STATEMENT_CHARS = 500;
export const MIN_CLAIM_STATEMENT_CHARS = 3;
export const MAX_CLAIM_EXCERPT_CHARS = 2_000;
/** Bounds how much one message may contribute, so a long note cannot flood the model. */
export const MAX_CLAIMS_PER_MESSAGE = 6;

/** What the model returns, before anything is verified. Treated as untrusted. */
export type RawClaimCandidate = {
  claimType: string;
  statement: string;
  excerpt: string;
};

/** A candidate that has been located in the user's own words and accepted. */
export type ClaimCandidate = {
  claimType: ClaimType;
  statement: string;
  canonicalKey: string;
  excerpt: string;
  charStart: number;
  charEnd: number;
  embedding?: number[];
  embeddingModel?: string;
};

export type ClaimRejectionReason =
  | "unknown_type"
  | "invalid_statement"
  | "invalid_excerpt"
  | "span_not_found"
  | "no_stance_marker"
  | "reported_speech";

export type ClaimExtractionResult = {
  candidates: ClaimCandidate[];
  /** Why candidates were dropped. Surfaced so silent loss is visible. */
  rejections: Record<ClaimRejectionReason, number>;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type ClaimSyncSummary = {
  claimsCreated: number;
  claimsReinforced: number;
  evidenceWritten: number;
};

/** A claim as read back for display. */
export type UserClaim = {
  id: string;
  claimType: ClaimType;
  assertedBy: "user" | "cortex";
  statement: string;
  status: ClaimStatus;
  confidence: number;
  confidenceMethod: string;
  validFrom: string;
  validTo: string | null;
  firstStatedAt: string;
  lastStatedAt: string;
  evidenceCount: number;
  /** Which inference rule produced this. Null for user-stated claims. */
  inferenceRule: string | null;
  /** The evidentiary bar this inference was created under. */
  inferenceMinEvidence: number | null;
};

/** The evidentiary bar for an inference. Mirrors `infer_sustained_interest`. */
export const SUSTAINED_INTEREST_MIN_CLAIMS = 3;
export const SUSTAINED_INTEREST_MIN_SPAN_DAYS = 14;

export type ClaimEvidenceRecord = {
  id: string;
  claimId: string;
  observationId: string;
  relation: "originates" | "supports" | "contradicts";
  excerpt: string | null;
  sourceMessageId: string | null;
  occurredAt: string;
};

export function emptyRejections(): Record<ClaimRejectionReason, number> {
  return {
    unknown_type: 0,
    invalid_statement: 0,
    invalid_excerpt: 0,
    span_not_found: 0,
    no_stance_marker: 0,
    reported_speech: 0,
  };
}
