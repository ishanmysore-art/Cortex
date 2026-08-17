/**
 * The Cortex observation taxonomy.
 *
 * An observation records that something happened. It is never a conclusion
 * about the user. "The user asked about X" is an observation; "the user is
 * interested in X" is an inference and does not belong in this file or in the
 * `observations` table — see docs/cortex-v2-architecture.md.
 *
 * The taxonomy lives here rather than in a Postgres enum so that adding an
 * event type is a typed code change instead of an `ALTER TYPE` against an
 * append-only table. `lib/observations/recorder.ts` validates against this
 * registry at the write boundary, so the database still only ever receives
 * known event types.
 */

export const OBSERVATION_ACTORS = ["user", "cortex", "system"] as const;
export type ObservationActor = (typeof OBSERVATION_ACTORS)[number];

/**
 * What `source_id` points at. `system` carries no source row — it is used for
 * events that have no durable entity of their own.
 */
export const OBSERVATION_SOURCE_TYPES = [
  "document",
  "document_chunk",
  "message",
  "conversation",
  "memory",
  "concept",
  "claim",
  "notice",
  "system",
] as const;
export type ObservationSourceType = (typeof OBSERVATION_SOURCE_TYPES)[number];

export const OBSERVATION_CATEGORIES = [
  /** The user and Cortex exchanging questions and answers. */
  "interaction",
  /** Material entering or leaving the knowledge base. */
  "document",
  /** The user looking something up. */
  "retrieval",
  /** A signal the user gave deliberately, not one Cortex derived. */
  "explicit_signal",
] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/**
 * Payload shape per event type.
 *
 * Two rules govern what goes in a payload, and the database enforces the
 * consequence with a size CHECK:
 *
 * 1. Never duplicate text that already has a durable home. Question and answer
 *    bodies live in `messages` and are reached through `source_id`.
 * 2. Do snapshot text that would otherwise be lost. A document title is copied
 *    because the document may later be deleted, and an observation nobody can
 *    interpret is worse than no observation. This mirrors the existing
 *    `message_citations` snapshot pattern.
 */
export type ObservationPayloads = {
  question_asked: {
    characterCount: number;
    /**
     * Whether the question continued an existing conversation.
     *
     * Turn depth is deliberately not stored: it is derivable exactly by
     * counting `question_asked` rows sharing a `context.conversationId`,
     * whereas anything computed here would be capped by the request's history
     * window and would silently saturate.
     */
    isFollowUp: boolean;
  };
  answer_generated: {
    model: string;
    promptVersion: string;
    citationCount: number;
    retrievedSourceCount: number;
    /** False when the grounding checks rejected every candidate answer. */
    grounded: boolean;
    latencyMs: number;
  };
  answer_failed: {
    stage: "retrieval" | "generation";
    reason: string;
  };
  evidence_cited: {
    citationIndex: number;
    documentId: string | null;
    /** Snapshot: the document may be deleted while this observation remains. */
    documentTitle: string;
    pageStart: number | null;
    pageEnd: number | null;
    similarity: number | null;
    /**
     * Concepts the cited passage carried, captured at citation time.
     *
     * Without these, attributing a citation to a concept requires joining
     * through `concept_mentions`, which cascades away with its document — so a
     * deleted document silently erased its own retrieval history. Snapshotting
     * here keeps the attribution durable.
     *
     * Both forms are stored: ids for a direct join, and canonical keys because
     * a concept pruned and recreated gets a new id while the key is its durable
     * identity. Empty when attribution could not be resolved.
     */
    conceptIds: string[];
    conceptKeys: string[];
  };
  search_performed: {
    /**
     * Stored because a search query has no other durable home, and recurring
     * questions are one of the signals this log exists to preserve.
     */
    query: string;
    resultCount: number;
    topSimilarity: number | null;
  };
  document_uploaded: {
    title: string;
    fileType: string;
    fileSizeBytes: number;
  };
  document_processed: {
    title: string;
    chunkCount: number;
    embeddingModel: string;
    embeddingTokens: number;
    durationMs: number;
  };
  document_processing_failed: {
    title: string;
    reason: string;
    attempt: number;
    willRetry: boolean;
  };
  document_deleted: {
    title: string;
  };
  /**
   * Concepts were derived from a document's text.
   *
   * `concepts` snapshots the canonical keys because `concept_mentions` is
   * derived state that disappears with its document: without this, "which ideas
   * did this document carry" would be lost the moment the document is deleted.
   * Individual mentions are deliberately not mirrored here — duplicating
   * rebuildable data into an append-only log would make the log the second
   * source of truth for something it does not own.
   */
  concepts_extracted: {
    title: string;
    conceptCount: number;
    mentionCount: number;
    newConceptCount: number;
    /** New `concept_encountered` observations. Zero when re-ingesting. */
    encountersRecorded: number;
    chunksAnalyzed: number;
    chunksSkipped: number;
    /** Model output dropped because its surface form was not found in the source. */
    rejectedMentions: number;
    model: string;
    durationMs: number;
    concepts: string[];
  };
  /** Extraction failed. The document still ingested: this stage is non-fatal. */
  concept_extraction_failed: {
    title: string;
    reason: string;
  };
  /**
   * The user encountered a concept in a document. One per concept per document.
   *
   * This is the durable evidence a future claim points at. `concept_mentions`
   * cannot serve that role: it is derived state that cascades away with its
   * document, and evidence that can silently vanish defeats the point of
   * requiring evidence at all.
   *
   * Written by `sync_document_concepts` in the same transaction as the mentions
   * it summarises, so an encounter cannot be lost to a worker crash between the
   * two writes. `occurred_at` is when the user added the document, not when
   * extraction ran.
   *
   * `canonicalKey` is the durable identity: a concept pruned and recreated gets
   * a new row id, so future joins should prefer the key when the concept row may
   * have turned over.
   */
  concept_encountered: {
    label: string;
    canonicalKey: string;
    /** Snapshot: the document may be deleted while this observation remains. */
    documentTitle: string;
    mentionCount: number;
  };
  /**
   * The user deliberately wrote something down for Cortex to carry forward.
   * This is the only explicit user-stated signal the product supports today.
   * It is recorded as "the user stated this", never as "the user believes this".
   */
  memory_stated: {
    characterCount: number;
  };
  /** The user withdrew a memory: an explicit rejection signal. */
  memory_archived: Record<string, never>;
  /**
   * The user explicitly stated a claim about their own thinking, at a verified
   * span of one of their messages.
   *
   * This is the evidence a `user_claims` row points at. It records only that
   * the statement was made — the claim row is the interpretation of it, and the
   * two are kept separate so the record of what was said survives any later
   * change to how it is categorised.
   *
   * Written by `record_user_claims` in the same transaction as the claim, so a
   * claim can never exist without the evidence that justifies it.
   */
  claim_stated: {
    claimType: string;
    canonicalKey: string;
    statement: string;
    /** The user's exact words, sliced from the message. */
    excerpt: string;
    charStart: number;
    charEnd: number;
  };
  /** The user hid a claim from their model. An explicit correction signal. */
  claim_archived: { claimType: string; canonicalKey: string };
  /** The user said a claim no longer represents them. Explicit correction. */
  claim_retracted: { claimType: string; canonicalKey: string };
  /** The user brought a closed claim back. */
  claim_restored: { claimType: string; canonicalKey: string };
  /**
   * A notice was actually shown to the user.
   *
   * Deliberately separate from detection: a notice can sit detected for days
   * before anyone opens the page, and "Cortex noticed this" is not the same
   * fact as "the user saw it". Without both, a dismissal rate means nothing.
   */
  notice_surfaced: { kind: string; subjectKey: string };
  /** The user found a notice worth keeping. */
  notice_accepted: { kind: string; subjectKey: string };
  /**
   * The user rejected a notice — the only honest signal that Cortex was wrong
   * to raise it, and the reason the response loop was built before the
   * detectors that produce them.
   */
  notice_dismissed: { kind: string; subjectKey: string };
};

export type ObservationEventType = keyof ObservationPayloads;

type EventDefinition = {
  category: ObservationCategory;
  actor: ObservationActor;
  sourceType: ObservationSourceType;
  /** Human-readable intent, kept next to the definition so it stays accurate. */
  describes: string;
};

export const OBSERVATION_EVENTS: {
  [K in ObservationEventType]: EventDefinition;
} = {
  question_asked: {
    category: "interaction",
    actor: "user",
    sourceType: "message",
    describes: "The user asked a question. Text lives in messages.",
  },
  answer_generated: {
    category: "interaction",
    actor: "cortex",
    sourceType: "message",
    describes: "Cortex produced an answer. Text lives in messages.",
  },
  answer_failed: {
    category: "interaction",
    actor: "cortex",
    sourceType: "conversation",
    describes: "Cortex could not produce an answer.",
  },
  evidence_cited: {
    category: "interaction",
    actor: "cortex",
    sourceType: "document_chunk",
    describes: "A specific passage was used to support an answer.",
  },
  search_performed: {
    category: "retrieval",
    actor: "user",
    sourceType: "system",
    describes: "The user ran a semantic search.",
  },
  document_uploaded: {
    category: "document",
    actor: "user",
    sourceType: "document",
    describes: "The user added a document to the knowledge base.",
  },
  document_processed: {
    category: "document",
    actor: "system",
    sourceType: "document",
    describes: "Ingestion completed and the document became searchable.",
  },
  document_processing_failed: {
    category: "document",
    actor: "system",
    sourceType: "document",
    describes: "Ingestion failed for a document.",
  },
  document_deleted: {
    category: "document",
    actor: "user",
    sourceType: "document",
    describes: "The user removed a document.",
  },
  concepts_extracted: {
    category: "document",
    actor: "system",
    sourceType: "document",
    describes: "Concepts were derived from a document and grounded in its text.",
  },
  concept_extraction_failed: {
    category: "document",
    actor: "system",
    sourceType: "document",
    describes: "Concept extraction failed for a document that otherwise ingested.",
  },
  concept_encountered: {
    category: "document",
    actor: "system",
    sourceType: "concept",
    describes: "The user encountered a concept in a document they added.",
  },
  memory_stated: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "memory",
    describes: "The user explicitly saved something for Cortex to remember.",
  },
  memory_archived: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "memory",
    describes: "The user explicitly withdrew a saved memory.",
  },
  claim_stated: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "message",
    describes: "The user explicitly stated something about their own thinking.",
  },
  claim_archived: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "claim",
    describes: "The user hid a claim from their model.",
  },
  claim_retracted: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "claim",
    describes: "The user said a claim no longer represents them.",
  },
  claim_restored: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "claim",
    describes: "The user brought a closed claim back.",
  },
  notice_surfaced: {
    category: "interaction",
    actor: "cortex",
    sourceType: "notice",
    describes: "A notice was shown to the user.",
  },
  notice_accepted: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "notice",
    describes: "The user found a notice worth keeping.",
  },
  notice_dismissed: {
    category: "explicit_signal",
    actor: "user",
    sourceType: "notice",
    describes: "The user rejected a notice.",
  },
};

export const OBSERVATION_EVENT_TYPES = Object.keys(
  OBSERVATION_EVENTS,
) as ObservationEventType[];

export function isObservationEventType(value: unknown): value is ObservationEventType {
  return typeof value === "string" && value in OBSERVATION_EVENTS;
}

/**
 * Structured references to the entities surrounding an event. Typed rather
 * than free-form so that later milestones can query provenance without
 * guessing at key names.
 */
export type ObservationContext = {
  conversationId?: string;
  messageId?: string;
  documentId?: string;
  chunkId?: string;
  jobId?: string;
  /** Set by background workers so an event can be traced to a worker run. */
  workerName?: string;
};

export type ObservationInput<
  K extends ObservationEventType = ObservationEventType,
> = {
  userId: string;
  eventType: K;
  /** The row this event is about. Required unless the event's sourceType is `system`. */
  sourceId?: string | null;
  /** Defaults to now. Pass explicitly when recording something that happened earlier. */
  occurredAt?: Date | string;
  context?: ObservationContext;
  payload: ObservationPayloads[K];
  /**
   * Makes a write idempotent. Any path that can run twice (retries, replays,
   * a reclaimed ingestion job) must set one.
   */
  dedupeKey?: string | null;
};

/** An observation as read back from the database. */
export type Observation<
  K extends ObservationEventType = ObservationEventType,
> = {
  id: string;
  userId: string;
  eventType: K;
  eventCategory: ObservationCategory;
  actor: ObservationActor;
  sourceType: ObservationSourceType;
  sourceId: string | null;
  occurredAt: string;
  recordedAt: string;
  context: ObservationContext;
  payload: ObservationPayloads[K];
  dedupeKey: string | null;
};

/** Mirrors the `observations_payload_size` CHECK so writers fail early and loudly. */
export const OBSERVATION_PAYLOAD_MAX_BYTES = 8_000;
export const OBSERVATION_CONTEXT_MAX_BYTES = 2_000;
