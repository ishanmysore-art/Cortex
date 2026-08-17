import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConceptKnowledgeState, KnowledgeState } from "@/lib/knowledge/types";

const COLUMNS =
  "concept_id, encounter_count, encounter_document_count, first_encountered_at, last_encountered_at, retrieval_count, retrieval_answer_count, first_retrieved_at, last_retrieved_at, derived_through_observation_id, concepts!inner(label, canonical_key)";

export type ListKnowledgeStatesOptions = {
  limit?: number;
  /** Ordering only. Not a ranking of how well anything is known. */
  orderBy?: "encounters" | "retrievals" | "recent";
};

/**
 * Reads the user's knowledge states with their concept labels.
 *
 * Scoping comes from RLS on `knowledge_states`; a user-scoped client is what
 * makes this safe.
 */
export async function listKnowledgeStates(
  supabase: SupabaseClient,
  { limit = 50, orderBy = "encounters" }: ListKnowledgeStatesOptions = {},
): Promise<{ states: ConceptKnowledgeState[]; error?: string }> {
  const column =
    orderBy === "retrievals"
      ? "retrieval_count"
      : orderBy === "recent"
        ? "last_encountered_at"
        : "encounter_count";

  const { data, error } = await supabase
    .from("knowledge_states")
    .select(COLUMNS)
    .order(column, { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(limit, 1), 200));

  if (error) {
    console.error("[knowledge] list failed:", error.message);
    return { states: [], error: error.message };
  }

  return { states: (data ?? []).map(toConceptKnowledgeState) };
}

/** Recomputes the caller's projection. Safe to call at any time. */
export async function refreshKnowledgeStates(supabase: SupabaseClient) {
  const { error } = await supabase.rpc("refresh_my_knowledge_states");
  if (error) {
    console.error("[knowledge] refresh failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export function toKnowledgeState(row: Record<string, unknown>): KnowledgeState {
  return {
    conceptId: row.concept_id as string,
    encounterCount: Number(row.encounter_count ?? 0),
    encounterDocumentCount: Number(row.encounter_document_count ?? 0),
    firstEncounteredAt: (row.first_encountered_at as string | null) ?? null,
    lastEncounteredAt: (row.last_encountered_at as string | null) ?? null,
    retrievalCount: Number(row.retrieval_count ?? 0),
    retrievalAnswerCount: Number(row.retrieval_answer_count ?? 0),
    firstRetrievedAt: (row.first_retrieved_at as string | null) ?? null,
    lastRetrievedAt: (row.last_retrieved_at as string | null) ?? null,
    derivedThroughObservationId: (row.derived_through_observation_id as string | null) ?? null,
  };
}

function toConceptKnowledgeState(row: Record<string, unknown>): ConceptKnowledgeState {
  // PostgREST returns an embedded row for an `!inner` join; older shapes give an array.
  const embedded = row.concepts as
    | { label?: string; canonical_key?: string }
    | Array<{ label?: string; canonical_key?: string }>
    | null;
  const concept = Array.isArray(embedded) ? embedded[0] : embedded;

  return {
    ...toKnowledgeState(row),
    label: concept?.label ?? "",
    canonicalKey: concept?.canonical_key ?? "",
  };
}
