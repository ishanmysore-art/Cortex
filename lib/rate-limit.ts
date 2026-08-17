import type { SupabaseClient } from "@supabase/supabase-js";

export async function consumeRateLimit(
  supabase: SupabaseClient,
  operation: "ask" | "search" | "upload" | "memory",
): Promise<boolean> {
  const { data, error } = await supabase.rpc("consume_rate_limit", {
    operation_name: operation,
  });

  if (error) {
    console.error("Rate-limit check failed:", error.message);
    // Fail closed. A missing migration should not make costly APIs public.
    return false;
  }

  return data === true;
}
