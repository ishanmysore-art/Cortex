/**
 * Knowledge states.
 *
 * A read-only projection over observations. It has no write path of its own —
 * `rebuild_concept_projections` produces it, and discarding the table and
 * rebuilding reproduces it exactly.
 */
export type { ConceptKnowledgeState, KnowledgeState } from "@/lib/knowledge/types";

export {
  listKnowledgeStates,
  refreshKnowledgeStates,
  toKnowledgeState,
  type ListKnowledgeStatesOptions,
} from "@/lib/knowledge/queries";
