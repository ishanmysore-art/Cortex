"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

type ClaimAction = "archived" | "retracted" | "active";

/**
 * The user's path to correct what Cortex holds about them.
 *
 * Nothing here edits a statement. Closing a claim records that the user no
 * longer stands behind it while preserving both the wording and its evidence —
 * changing your mind is part of your intellectual history, not a deletion of it.
 */
async function setClaimStatus(id: string, status: ClaimAction) {
  if (!isUuid(id)) return { error: "Invalid claim." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  // `close_user_claim` resolves the owner from the session, so a claim
  // belonging to anyone else simply matches nothing.
  const { data, error } = await supabase.rpc("close_user_claim", {
    target_claim_id: id,
    new_status: status,
  });

  if (error) {
    console.error("Failed to update claim status", error);
    return { error: "Unable to update this claim." };
  }
  if ((data as { updated?: number } | null)?.updated === 0) {
    return { error: "Claim not found." };
  }

  revalidatePath("/dashboard/model");
  return { success: true };
}

export async function archiveClaim(id: string) {
  return setClaimStatus(id, "archived");
}

export async function retractClaim(id: string) {
  return setClaimStatus(id, "retracted");
}

export async function restoreClaim(id: string) {
  return setClaimStatus(id, "active");
}
