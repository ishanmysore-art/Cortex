import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Notice,
  NoticeDetectionSummary,
  NoticeKind,
  NoticeResponse,
} from "@/lib/notices/types";

const COLUMNS =
  "id, kind, subject_key, payload, confidence_method, detected_at, surfaced_at, response, responded_at";

/**
 * Reads the user's notices.
 *
 * Scoping comes from RLS; a user-scoped client is what makes this safe.
 * Dismissed notices are excluded by default — the point of a dismissal is not
 * seeing it again.
 */
export async function listNotices(
  supabase: SupabaseClient,
  {
    responses = ["pending", "accepted"],
    limit = 20,
  }: { responses?: NoticeResponse[]; limit?: number } = {},
): Promise<{ notices: Notice[]; error?: string }> {
  const { data, error } = await supabase
    .from("notices")
    .select(COLUMNS)
    .in("response", responses)
    .order("detected_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) {
    console.error("[notices] list failed:", error.message);
    return { notices: [], error: error.message };
  }
  return { notices: (data ?? []).map(toNotice) };
}

/** Runs detection for the signed-in user. Never throws. */
export async function refreshNotices(
  supabase: SupabaseClient,
): Promise<{ ok: boolean; summary?: NoticeDetectionSummary; error?: string }> {
  const { data, error } = await supabase.rpc("refresh_my_notices");
  if (error) {
    console.error("[notices] refresh failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, summary: (data ?? undefined) as NoticeDetectionSummary | undefined };
}

/**
 * Records that pending notices were actually shown.
 *
 * Kept separate from detection because they are different facts: a notice can
 * sit detected for days before anyone opens the page, and without both a
 * dismissal rate is uninterpretable.
 */
export async function markNoticesSurfaced(supabase: SupabaseClient) {
  const { error } = await supabase.rpc("mark_my_notices_surfaced");
  if (error) {
    console.error("[notices] surfacing failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export function toNotice(row: Record<string, unknown>): Notice {
  return {
    id: row.id as string,
    kind: row.kind as NoticeKind,
    subjectKey: row.subject_key as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    confidenceMethod: row.confidence_method as string,
    detectedAt: row.detected_at as string,
    surfacedAt: (row.surfaced_at as string | null) ?? null,
    response: row.response as NoticeResponse,
    respondedAt: (row.responded_at as string | null) ?? null,
  };
}
