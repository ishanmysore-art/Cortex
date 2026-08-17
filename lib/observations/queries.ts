import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Observation,
  ObservationCategory,
  ObservationEventType,
  ObservationSourceType,
} from "@/lib/observations/types";

const SELECT_COLUMNS =
  "id, user_id, event_type, event_category, actor, source_type, source_id, occurred_at, recorded_at, context, payload, dedupe_key";

export type ListObservationsOptions = {
  eventTypes?: ObservationEventType[];
  categories?: ObservationCategory[];
  /** Narrow to everything that happened to one entity. */
  source?: { type: ObservationSourceType; id: string };
  /** Inclusive lower bound on `occurred_at`. */
  since?: Date | string;
  /** Exclusive upper bound on `occurred_at`. */
  until?: Date | string;
  limit?: number;
  /** Newest first by default, which is what a timeline read wants. */
  order?: "asc" | "desc";
  /**
   * Only needed when reading through the service role, which bypasses RLS. A
   * user-scoped client is already constrained to its own rows.
   */
  userId?: string;
};

const MAX_LIMIT = 200;

/**
 * Reads a slice of the observation history.
 *
 * Scoping is enforced by RLS on `observations`, not by this function. Passing a
 * user-scoped Supabase client is what makes the read safe; `userId` is an
 * additional filter for service-role callers, never the primary guard.
 */
export async function listObservations(
  supabase: SupabaseClient,
  options: ListObservationsOptions = {},
): Promise<{ observations: Observation[]; error?: string }> {
  let query = supabase.from("observations").select(SELECT_COLUMNS);

  if (options.userId) query = query.eq("user_id", options.userId);
  if (options.eventTypes?.length) query = query.in("event_type", options.eventTypes);
  if (options.categories?.length) query = query.in("event_category", options.categories);
  if (options.source) {
    query = query.eq("source_type", options.source.type).eq("source_id", options.source.id);
  }
  if (options.since) query = query.gte("occurred_at", toIso(options.since));
  if (options.until) query = query.lt("occurred_at", toIso(options.until));

  const ascending = options.order === "asc";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LIMIT);

  // The id tiebreak matches `observations_user_occurred_idx` and keeps the
  // ordering total when several events share a timestamp.
  const { data, error } = await query
    .order("occurred_at", { ascending })
    .order("id", { ascending })
    .limit(limit);

  if (error) {
    console.error("[observations] list failed:", error.message);
    return { observations: [], error: error.message };
  }

  return { observations: (data ?? []).map(toObservation) };
}

export async function getObservation(
  supabase: SupabaseClient,
  id: string,
): Promise<{ observation: Observation | null; error?: string }> {
  const { data, error } = await supabase
    .from("observations")
    .select(SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[observations] get failed:", error.message);
    return { observation: null, error: error.message };
  }
  return { observation: data ? toObservation(data) : null };
}

/** Maps the database row shape to the application type. */
export function toObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    eventType: row.event_type as ObservationEventType,
    eventCategory: row.event_category as ObservationCategory,
    actor: row.actor as Observation["actor"],
    sourceType: row.source_type as ObservationSourceType,
    sourceId: (row.source_id as string | null) ?? null,
    occurredAt: row.occurred_at as string,
    recordedAt: row.recorded_at as string,
    context: (row.context ?? {}) as Observation["context"],
    payload: (row.payload ?? {}) as Observation["payload"],
    dedupeKey: (row.dedupe_key as string | null) ?? null,
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
