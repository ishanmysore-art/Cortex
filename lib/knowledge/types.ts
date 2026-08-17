/**
 * Knowledge states: a derived, rebuildable view of what the observation log
 * already says about each concept.
 *
 * Everything here is a count or a timestamp. There is deliberately no mastery,
 * familiarity, confidence, or decay field — nothing in the log supports one, and
 * a number without support is exactly what this architecture exists to prevent.
 */

export type KnowledgeState = {
  conceptId: string;
  /** Times the user met this idea in material they added. */
  encounterCount: number;
  /** Distinct documents those encounters came from. */
  encounterDocumentCount: number;
  firstEncounteredAt: string | null;
  lastEncounteredAt: string | null;
  /** Times a passage mentioning it was cited in an answer. */
  retrievalCount: number;
  /** Distinct answers that drew on it. */
  retrievalAnswerCount: number;
  firstRetrievedAt: string | null;
  lastRetrievedAt: string | null;
  /** Newest observation folded into this row. */
  derivedThroughObservationId: string | null;
};

/** A knowledge state joined to its concept, for display. */
export type ConceptKnowledgeState = KnowledgeState & {
  label: string;
  canonicalKey: string;
};
