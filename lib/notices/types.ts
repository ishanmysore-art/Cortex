/**
 * Proactive notices.
 *
 * A notice reports counted facts about the user's own material. It never judges
 * what they know: a "you have a gap in X" notice would be the mastery inference
 * Milestone 4 ruled out, and nothing in the log distinguishes a citation that
 * helped from one that did not.
 *
 * Nothing here surfaces autonomously. Notices are detected when the evidence
 * behind them changes and shown only when the user opens the page.
 */

export const NOTICE_KINDS = [
  /** Two ideas that keep turning up together across separate documents. */
  "concept_connection",
  /** One idea the user keeps meeting across separate documents over time. */
  "recurring_concept",
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && (NOTICE_KINDS as readonly string[]).includes(value);
}

export const NOTICE_RESPONSES = ["pending", "accepted", "dismissed"] as const;
export type NoticeResponse = (typeof NOTICE_RESPONSES)[number];

/**
 * Detection thresholds. Mirrors the defaults in `detect_notices`.
 *
 * These are the cold-start gate: a notice fires on accumulated evidence, not
 * after a set time, so a two-week-old corpus simply produces nothing rather
 * than producing noise.
 */
export const NOTICE_THRESHOLDS = {
  minSharedPassages: 3,
  minSharedDocuments: 2,
  minRecurringDocuments: 3,
  minRecurringSpanDays: 30,
} as const;

export type NoticePayloads = {
  concept_connection: {
    labelA: string;
    labelB: string;
    passageCount: number;
    documentCount: number;
  };
  recurring_concept: {
    label: string;
    canonicalKey: string;
    documentCount: number;
    encounterCount: number;
    firstEncounteredAt: string | null;
    lastEncounteredAt: string | null;
  };
};

export type Notice = {
  id: string;
  kind: NoticeKind;
  /** Built from canonical keys, never row ids, so a dismissal is durable. */
  subjectKey: string;
  payload: Record<string, unknown>;
  /** An inspectable sentence built from the counts, never a score. */
  confidenceMethod: string;
  detectedAt: string;
  surfacedAt: string | null;
  response: NoticeResponse;
  respondedAt: string | null;
};

export type NoticeDetectionSummary = {
  connections: number;
  recurring: number;
};
