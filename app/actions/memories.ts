"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordObservation } from "@/lib/observations";
import { createClient } from "@/lib/supabase/server";
import { MAX_MEMORY_CHARS, validateTextInput } from "@/lib/validation";

export async function addMemory(formData: FormData) {
  const content = validateTextInput(formData.get("content"), MAX_MEMORY_CHARS, "Memory");
  if (typeof content !== "string") return content;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };
  if (!(await consumeRateLimit(supabase, "memory"))) {
    return { error: "Memory limit reached. Please wait a minute and try again." };
  }

  const { data: memory, error } = await supabase
    .from("memories")
    .insert({ user_id: user.id, content })
    .select("id")
    .single();
  if (error || !memory) {
    console.error("Failed to save memory", error);
    return { error: "Unable to save memory." };
  }

  // Recorded as "the user stated this", never as "the user believes this".
  // Turning an explicit statement into a belief is the inference layer's job,
  // and that layer does not exist yet.
  after(async () => {
    await recordObservation(supabase, {
      userId: user.id,
      eventType: "memory_stated",
      sourceId: memory.id,
      payload: { characterCount: content.length },
      dedupeKey: `memory_stated:${memory.id}`,
    });
    // Mirror the memory into the claim model so the two do not diverge while
    // `memories` remains in place. Idempotent, and keyed to the memory id.
    const { error: claimError } = await supabase.rpc("sync_memory_claim", {
      target_memory_id: memory.id,
    });
    if (claimError) console.error("Failed to mirror memory into claims", claimError);
  });

  revalidatePath("/dashboard/ask");
  return { success: true };
}

export async function archiveMemory(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { error } = await supabase
    .from("memories")
    .update({ status: "archived" })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) {
    console.error("Failed to archive memory", error);
    return { error: "Unable to remove memory." };
  }

  // Archiving the memory archives the claim it maps to. The claim and its
  // evidence are kept, not deleted: the user withdrawing something is part of
  // their history, not an erasure of it.
  const { data: mirrored } = await supabase
    .from("user_claims")
    .select("id")
    .eq("source_memory_id", id)
    .maybeSingle();
  if (mirrored?.id) {
    const { error: closeError } = await supabase.rpc("close_user_claim", {
      target_claim_id: mirrored.id,
      new_status: "archived",
    });
    if (closeError) console.error("Failed to archive mirrored claim", closeError);
  }

  after(async () => {
    await recordObservation(supabase, {
      userId: user.id,
      eventType: "memory_archived",
      sourceId: id,
      payload: {},
      dedupeKey: `memory_archived:${id}`,
    });
  });

  revalidatePath("/dashboard/ask");
  return { success: true };
}
