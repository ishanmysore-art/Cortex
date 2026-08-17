import type { SupabaseClient } from "@supabase/supabase-js";
import { extractConceptCandidates } from "@/lib/concepts/extractor";
import type { ConceptCandidate, ConceptSourceChunk, ConceptSyncSummary } from "@/lib/concepts/types";
import { recordAiUsage } from "@/lib/observability";
import openai from "@/lib/openai/client";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 96;

/**
 * How close a new label must be to an existing concept before it is treated as
 * the same idea. Set high on purpose: this only ever attaches a new surface
 * form to an existing concept, so being too strict costs a duplicate row that
 * can be merged later, while being too loose destroys a distinction that cannot
 * be recovered.
 */
export const CONCEPT_SIMILARITY_THRESHOLD = 0.95;

export type ConceptSyncResult = ConceptSyncSummary & {
  chunksAnalyzed: number;
  chunksSkipped: number;
  rejectedMentions: number;
  candidateCount: number;
  model: string;
  durationMs: number;
  /** Canonical keys, most-mentioned first. Preserved in the observation log. */
  topConcepts: string[];
};

/** Reads back the stored chunks so mentions can be anchored to durable ids. */
export async function loadConceptSourceChunks(
  supabase: SupabaseClient,
  documentId: string,
): Promise<ConceptSourceChunk[]> {
  const { data, error } = await supabase
    .from("document_chunks")
    .select("id, chunk_index, content, page_start, page_end")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    chunkIndex: row.chunk_index as number,
    content: row.content as string,
    pageStart: (row.page_start as number | null) ?? null,
    pageEnd: (row.page_end as number | null) ?? null,
  }));
}

/** Embeds canonical labels so near-duplicate surface variants can be resolved. */
export async function embedConceptCandidates(candidates: ConceptCandidate[]) {
  let embeddingTokens = 0;

  for (let offset = 0; offset < candidates.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch.map((candidate) => candidate.label),
    });
    embeddingTokens += response.usage.total_tokens;

    if (response.data.length !== batch.length) {
      throw new Error("Embedding provider returned an incomplete concept batch.");
    }
    batch.forEach((candidate, index) => {
      candidate.embedding = response.data[index].embedding;
      candidate.embeddingModel = EMBEDDING_MODEL;
    });
  }

  return embeddingTokens;
}

/**
 * Extracts, grounds, and persists one document's concepts.
 *
 * The database call is a single atomic RPC: resolution, mention replacement,
 * counter refresh, orphan pruning, and edge rebuild either all happen or none
 * do, so the graph is never observed in a half-synced state.
 */
export async function syncDocumentConcepts(
  supabase: SupabaseClient,
  {
    userId,
    documentId,
    documentTitle,
    chunks,
  }: {
    userId: string;
    documentId: string;
    documentTitle: string;
    chunks: ConceptSourceChunk[];
  },
): Promise<ConceptSyncResult> {
  const startedAt = Date.now();
  const extraction = await extractConceptCandidates(chunks, { documentTitle });

  let embeddingTokens = 0;
  if (extraction.candidates.length > 0) {
    embeddingTokens = await embedConceptCandidates(extraction.candidates);
  }

  const { data, error } = await supabase.rpc("sync_document_concepts", {
    target_user_id: userId,
    target_document_id: documentId,
    candidates: extraction.candidates,
    similarity_threshold: CONCEPT_SIMILARITY_THRESHOLD,
  });
  if (error) throw error;

  const summary = (data ?? {}) as Partial<ConceptSyncSummary>;

  await recordAiUsage(supabase, {
    userId,
    operation: "upload",
    model: extraction.model,
    inputTokens: extraction.inputTokens + embeddingTokens,
    outputTokens: extraction.outputTokens,
    latencyMs: Date.now() - startedAt,
  });

  return {
    conceptsCreated: summary.conceptsCreated ?? 0,
    conceptsMatchedExact: summary.conceptsMatchedExact ?? 0,
    conceptsMatchedSemantic: summary.conceptsMatchedSemantic ?? 0,
    embeddingsBackfilled: summary.embeddingsBackfilled ?? 0,
    mentionsWritten: summary.mentionsWritten ?? 0,
    encountersRecorded: summary.encountersRecorded ?? 0,
    prunedConcepts: summary.prunedConcepts ?? 0,
    edges: summary.edges ?? 0,
    chunksAnalyzed: extraction.chunksAnalyzed,
    chunksSkipped: extraction.chunksSkipped,
    rejectedMentions: extraction.rejectedMentions,
    candidateCount: extraction.candidates.length,
    model: extraction.model,
    durationMs: Date.now() - startedAt,
    topConcepts: summarizeTopConcepts(extraction.candidates),
  };
}

/**
 * Picks the concept keys worth preserving in the append-only log.
 *
 * `concept_mentions` is derived state and disappears with its document, so this
 * short list is what survives to answer "which ideas did this document carry,
 * back when it was ingested". Bounded to stay well inside the observation
 * payload size limit.
 */
export function summarizeTopConcepts(candidates: ConceptCandidate[], limit = 40): string[] {
  return [...candidates]
    .sort((left, right) => right.mentions.length - left.mentions.length)
    .slice(0, limit)
    .map((candidate) => candidate.canonicalKey)
    .filter((key) => key.length <= 80);
}
