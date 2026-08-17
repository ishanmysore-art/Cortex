import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OBSERVATION_CONTEXT_MAX_BYTES,
  OBSERVATION_EVENTS,
  OBSERVATION_PAYLOAD_MAX_BYTES,
  isObservationEventType,
  type ObservationEventType,
  type ObservationInput,
} from "@/lib/observations/types";

export type ObservationRow = {
  user_id: string;
  event_type: string;
  event_category: string;
  actor: string;
  source_type: string;
  source_id: string | null;
  occurred_at: string;
  context: Record<string, unknown>;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
};

export type RecordResult = {
  /** Rows sent to the database. Duplicates suppressed by `dedupe_key` still count as attempted. */
  attempted: number;
  ok: boolean;
  /** Present when the write failed or an input was rejected before the write. */
  error?: string;
};

/**
 * Turns a typed input into the database row shape, deriving category, actor,
 * and source type from the taxonomy so call sites cannot drift from it.
 *
 * Exported for testing; call sites should use `recordObservation`.
 */
export function buildObservationRow<K extends ObservationEventType>(
  input: ObservationInput<K>,
): ObservationRow {
  if (!isObservationEventType(input.eventType)) {
    throw new Error(`Unknown observation event type: ${String(input.eventType)}`);
  }
  if (!input.userId) {
    throw new Error(`Observation ${input.eventType} is missing a user id.`);
  }

  const definition = OBSERVATION_EVENTS[input.eventType];
  const sourceId = input.sourceId ?? null;
  if (definition.sourceType !== "system" && !sourceId) {
    throw new Error(
      `Observation ${input.eventType} requires a ${definition.sourceType} source id.`,
    );
  }

  const context = (input.context ?? {}) as Record<string, unknown>;
  const payload = (input.payload ?? {}) as Record<string, unknown>;

  assertWithinLimit(payload, OBSERVATION_PAYLOAD_MAX_BYTES, "payload", input.eventType);
  assertWithinLimit(context, OBSERVATION_CONTEXT_MAX_BYTES, "context", input.eventType);

  const occurredAt = input.occurredAt ?? new Date();

  return {
    user_id: input.userId,
    event_type: input.eventType,
    event_category: definition.category,
    actor: definition.actor,
    source_type: definition.sourceType,
    source_id: sourceId,
    occurred_at:
      occurredAt instanceof Date ? occurredAt.toISOString() : new Date(occurredAt).toISOString(),
    context,
    payload,
    dedupe_key: input.dedupeKey ?? null,
  };
}

/**
 * Records one observation.
 *
 * Never throws. A failure to record history must not fail the user's request,
 * so problems are logged and surfaced through the return value instead. Callers
 * that care can inspect `ok`; most call sites deliberately ignore it.
 */
export async function recordObservation<K extends ObservationEventType>(
  supabase: SupabaseClient,
  input: ObservationInput<K>,
): Promise<RecordResult> {
  return recordObservations(supabase, [input as ObservationInput]);
}

/**
 * Records a batch in a single round trip.
 *
 * Rows whose `dedupe_key` already exists for that user are ignored rather than
 * erroring, which makes every instrumented path safe to run more than once.
 */
export async function recordObservations(
  supabase: SupabaseClient,
  inputs: ObservationInput[],
): Promise<RecordResult> {
  if (inputs.length === 0) return { attempted: 0, ok: true };

  let rows: ObservationRow[];
  try {
    rows = inputs.map((input) => buildObservationRow(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid observation input.";
    console.error("[observations] rejected before write:", message);
    return { attempted: inputs.length, ok: false, error: message };
  }

  try {
    const { error } = await supabase
      .from("observations")
      .upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });

    if (error) {
      console.error("[observations] write failed:", error.message);
      return { attempted: rows.length, ok: false, error: error.message };
    }
    return { attempted: rows.length, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Observation write failed.";
    console.error("[observations] write threw:", message);
    return { attempted: rows.length, ok: false, error: message };
  }
}

function assertWithinLimit(
  value: Record<string, unknown>,
  maxBytes: number,
  field: "payload" | "context",
  eventType: string,
) {
  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size > maxBytes) {
    throw new Error(
      `Observation ${eventType} ${field} is ${size} bytes, over the ${maxBytes} byte limit. ` +
        "Reference the source row instead of copying its content.",
    );
  }
}
