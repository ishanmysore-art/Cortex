import type { SupabaseClient } from "@supabase/supabase-js";
import { extractClaimCandidates } from "@/lib/claims/extractor";
import type { ClaimCandidate, ClaimSyncSummary } from "@/lib/claims/types";
import { recordAiUsage } from "@/lib/observability";
import openai from "@/lib/openai/client";

const EMBEDDING_MODEL = "text-embedding-3-small";

export type ClaimSyncResult = ClaimSyncSummary & {
  candidateCount: number;
  rejectedCount: number;
  model: string;
  durationMs: number;
};

/**
 * Embeds claim statements.
 *
 * Stored for future revision and contradiction work only; nothing in this
 * milestone uses the vector to decide identity. Populating it now avoids a
 * backfill against claims whose evidence may since have been erased.
 */
export async function embedClaimCandidates(candidates: ClaimCandidate[]) {
  if (candidates.length === 0) return 0;

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: candidates.map((candidate) => candidate.statement),
  });

  if (response.data.length !== candidates.length) {
    throw new Error("Embedding provider returned an incomplete claim batch.");
  }
  candidates.forEach((candidate, index) => {
    candidate.embedding = response.data[index].embedding;
    candidate.embeddingModel = EMBEDDING_MODEL;
  });

  return response.usage.total_tokens;
}

/**
 * Extracts and records explicit claims from one user message.
 *
 * The database call is a single atomic RPC: the evidencing observation, the
 * claim, and the evidence link are written together, so a claim can never be
 * observed without the evidence that justifies it.
 */
export async function syncMessageClaims(
  supabase: SupabaseClient,
  { userId, messageId, content }: { userId: string; messageId: string; content: string },
): Promise<ClaimSyncResult> {
  const startedAt = Date.now();
  const extraction = await extractClaimCandidates(content);
  const rejectedCount = Object.values(extraction.rejections).reduce((sum, n) => sum + n, 0);

  let embeddingTokens = 0;
  if (extraction.candidates.length > 0) {
    embeddingTokens = await embedClaimCandidates(extraction.candidates);
  }

  let summary: Partial<ClaimSyncSummary> = {};
  if (extraction.candidates.length > 0) {
    // The RPC derives the owner from the session, so a user-scoped client is
    // required here and ownership cannot be forged by the caller.
    const { data, error } = await supabase.rpc("record_user_claims", {
      target_message_id: messageId,
      candidates: extraction.candidates,
    });
    if (error) throw error;
    summary = (data ?? {}) as Partial<ClaimSyncSummary>;
  }

  if (extraction.inputTokens > 0 || embeddingTokens > 0) {
    await recordAiUsage(supabase, {
      userId,
      operation: "ask",
      model: extraction.model,
      inputTokens: extraction.inputTokens + embeddingTokens,
      outputTokens: extraction.outputTokens,
      latencyMs: Date.now() - startedAt,
    });
  }

  return {
    claimsCreated: summary.claimsCreated ?? 0,
    claimsReinforced: summary.claimsReinforced ?? 0,
    evidenceWritten: summary.evidenceWritten ?? 0,
    candidateCount: extraction.candidates.length,
    rejectedCount,
    model: extraction.model,
    durationMs: Date.now() - startedAt,
  };
}
