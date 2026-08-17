"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { randomUUID } from "crypto";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordObservation } from "@/lib/observations";
import { validateUpload } from "@/lib/validation";
import { processQueuedIngestionJobs } from "@/lib/ingestion/processor";

export async function uploadDocument(formData: FormData) {
  const file = formData.get("file") as File | null;
  if (!file) {
    return { error: "No file provided" };
  }

  const validated = validateUpload(file);
  if ("error" in validated) {
    return validated;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Not authenticated" };
  }

  if (!(await consumeRateLimit(supabase, "upload"))) {
    return { error: "Upload limit reached. Please wait a minute and try again." };
  }

  try {
    // 1. Upload raw input. The processing worker reads it later, outside this request.
    const extension = validated.fileType === "markdown" ? "md" : validated.fileType === "text" ? "txt" : "pdf";
    const filePath = `${user.id}/${randomUUID()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(filePath, file);

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return { error: "Failed to upload file to storage" };
    }

    // 2. Store a pending document and a durable job. The worker is responsible for
    // parsing, chunking, embeddings, retries, and the final ready/failed state.
    const { data: document, error: dbError } = await supabase
      .from("documents")
      .insert({
        user_id: user.id,
        title: validated.title,
        file_type: validated.fileType,
        status: "pending",
        file_path: filePath,
        mime_type: validated.mimeType,
        file_size_bytes: file.size,
      })
      .select()
      .single();

    if (dbError || !document) {
      console.error("DB Error:", dbError);
      await supabase.storage.from("documents").remove([filePath]);
      return { error: "Failed to create document record" };
    }

    const { error: jobError } = await supabase.from("ingestion_jobs").insert({
      user_id: user.id,
      document_id: document.id,
    });

    if (jobError) {
      console.error("Ingestion job error:", jobError);
      await supabase.from("documents").delete().eq("id", document.id);
      await supabase.storage.from("documents").remove([filePath]);
      return { error: "Failed to queue document processing" };
    }

    // `after` runs once the response is flushed, so history is recorded off the
    // critical path while still being tracked by the framework rather than
    // detached into an untracked promise.
    after(async () => {
      await recordObservation(supabase, {
        userId: user.id,
        eventType: "document_uploaded",
        sourceId: document.id,
        context: { documentId: document.id },
        payload: {
          title: validated.title,
          fileType: validated.fileType,
          fileSizeBytes: file.size,
        },
        dedupeKey: `document_uploaded:${document.id}`,
      });
    });

    // Kick off immediate ingestion processing so upload doesn't block. A worker
    // that dies here no longer strands the job: `reclaim_stale_ingestion_jobs`
    // returns it to the queue on a later cycle.
    after(async () => {
      try {
        await processQueuedIngestionJobs(`action:${user.id}`);
      } catch (err) {
        console.error("Immediate background ingestion trigger failed:", err);
      }
    });

    revalidatePath("/dashboard/notes");
    return { success: true, message: "Document queued for processing." };

  } catch (error) {
    console.error("Unexpected error during upload:", error);
    return { error: "An unexpected error occurred" };
  }
}

export async function deleteDocument(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Not authenticated" };
  }

  // Fetch the document first to get its storage path and verify ownership via RLS
  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("id, file_path, user_id, title")
    .eq("id", id)
    .single();

  if (fetchError || !document) {
    return { error: "Document not found" };
  }

  // Extra ownership guard on top of RLS
  if (document.user_id !== user.id) {
    return { error: "Unauthorized" };
  }

  // Delete storage object first (best-effort — don't block DB deletion if it fails)
  await supabase.storage.from("documents").remove([document.file_path]);

  // Delete DB record — chunks cascade via ON DELETE CASCADE
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", id);

  if (deleteError) {
    console.error("Delete error:", deleteError);
    return { error: "Failed to delete document" };
  }

  // Chunks and mentions cascade with the document, which leaves concept
  // counters stale and can orphan concepts. Reconciling here keeps the hard
  // rule true: no concept without at least one mention.
  const { error: pruneError } = await supabase.rpc("prune_orphan_concepts");
  if (pruneError) console.error("Failed to reconcile concepts after delete", pruneError);

  // The document row is gone but the history of having had it is not. The title
  // is snapshotted here precisely because `source_id` now dangles by design.
  after(async () => {
    await recordObservation(supabase, {
      userId: user.id,
      eventType: "document_deleted",
      sourceId: document.id,
      context: { documentId: document.id },
      payload: { title: document.title },
      dedupeKey: `document_deleted:${document.id}`,
    });
  });

  revalidatePath("/dashboard/notes");
  return { success: true };
}
