"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

/**
 * Records the user's response to a notice.
 *
 * A dismissal is permanent — the unique constraint on (kind, subject_key) means
 * detection can never recreate it. Re-offering something a person has already
 * rejected is how a proactive feature burns trust.
 */
async function respond(id: string, response: "accepted" | "dismissed") {
  if (!isUuid(id)) return { error: "Invalid notice." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  // The RPC resolves the owner from the session, so another user's notice
  // simply matches nothing.
  const { data, error } = await supabase.rpc("respond_to_notice", {
    target_notice_id: id,
    new_response: response,
  });

  if (error) {
    console.error("Failed to record notice response", error);
    return { error: "Unable to record that." };
  }
  if ((data as { updated?: number } | null)?.updated === 0) {
    return { error: "Notice not found." };
  }

  revalidatePath("/dashboard/model");
  return { success: true as const };
}

export async function acceptNotice(id: string) {
  return respond(id, "accepted");
}

export async function dismissNotice(id: string) {
  return respond(id, "dismissed");
}
