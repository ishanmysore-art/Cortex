import type { SupabaseClient } from "@supabase/supabase-js";

export async function recordAiUsage(
  supabase: SupabaseClient,
  event: {
    userId: string;
    operation: "ask" | "search" | "upload";
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    latencyMs?: number;
  },
) {
  const { error } = await supabase.from("ai_usage_events").insert({
    user_id: event.userId,
    operation: event.operation,
    model: event.model ?? null,
    input_tokens: event.inputTokens ?? null,
    output_tokens: event.outputTokens ?? null,
    cached_tokens: event.cachedTokens ?? null,
    cache_write_tokens: event.cacheWriteTokens ?? null,
    latency_ms: event.latencyMs ?? null,
  });

  if (error) {
    console.error("Failed to record AI usage:", error.message);
  }
}
