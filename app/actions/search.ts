"use server";

import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import openai from "@/lib/openai/client";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordObservation } from "@/lib/observations";
import { MAX_SEARCH_QUERY_CHARS, validateTextInput } from "@/lib/validation";
import { recordAiUsage } from "@/lib/observability";

export interface SearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
  document_title: string;
  document_file_type: string;
  page_start: number | null;
  page_end: number | null;
}

export async function searchNotes(
  query: string,
  limit: number = 8
): Promise<{ results?: SearchResult[]; error?: string }> {
  const validatedQuery = validateTextInput(query, MAX_SEARCH_QUERY_CHARS, "Search query");
  if (typeof validatedQuery !== "string") {
    return query.trim() ? validatedQuery : { results: [] };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Not authenticated" };
  }

  if (!(await consumeRateLimit(supabase, "search"))) {
    return { error: "Search limit reached. Please wait a minute and try again." };
  }

  try {
    const startedAt = Date.now();
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
    // 1. Embed the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: validatedQuery,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Cosine similarity search via pgvector (RLS enforced inside function)
    const { data: chunks, error: rpcError } = await supabase.rpc(
      "match_document_chunks",
      {
        query_embedding: queryEmbedding,
        match_threshold: 0.2,
        match_count: safeLimit,
      }
    );

    if (rpcError) {
      console.error("Vector search error:", rpcError);
      return { error: "Failed to search notes" };
    }

    const results: SearchResult[] = (chunks ?? []) as SearchResult[];

    // A search query has no other durable home, so unlike a question (which
    // lives in `messages`) the text itself is recorded. Recurring questions are
    // one of the signals this log exists to preserve.
    after(async () => {
      await recordObservation(supabase, {
        userId: user.id,
        eventType: "search_performed",
        payload: {
          query: validatedQuery.slice(0, 1_000),
          resultCount: results.length,
          topSimilarity: results[0]?.similarity ?? null,
        },
      });
    });

    if (results.length === 0) {
      return { results: [] };
    }

    await recordAiUsage(supabase, {
      userId: user.id,
      operation: "search",
      model: "text-embedding-3-small",
      inputTokens: embeddingResponse.usage.total_tokens,
      latencyMs: Date.now() - startedAt,
    });

    return { results };
  } catch (error) {
    console.error("Unexpected error during search:", error);
    return { error: "An unexpected error occurred during search" };
  }
}
