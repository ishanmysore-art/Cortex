import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkTextWithMetadata } from "@/lib/documents/chunker";
import { loadConceptSourceChunks, syncDocumentConcepts } from "@/lib/concepts/sync";
import { extractDocumentFromFile } from "@/lib/documents/parsers";
import { recordObservation } from "@/lib/observations";
import openai from "@/lib/openai/client";
import { recordAiUsage } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_EXTRACTED_TEXT_CHARS } from "@/lib/validation";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 96;

/** Jobs abandoned for longer than this are returned to the queue. */
export const STALE_JOB_SECONDS = 15 * 60;

type IngestionJob = {
  id: string;
  user_id: string;
  document_id: string;
  attempts: number;
  max_attempts: number;
  /** Part of the ownership fence; see `releaseJob`. */
  locked_by: string | null;
  locked_at: string | null;
};

export async function processClaimedIngestionJob(job: IngestionJob) {
  const supabase = createAdminClient();
  const startedAt = Date.now();
  // Captured outside the try so a failure observation can still name the document.
  let documentTitle: string | null = null;

  try {
    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("id, user_id, title, file_path, mime_type")
      .eq("id", job.document_id)
      .eq("user_id", job.user_id)
      .single();

    if (documentError || !document) {
      throw new Error("Document is no longer available.");
    }
    documentTitle = document.title;

    await supabase
      .from("documents")
      .update({ status: "processing", extraction_error: null })
      .eq("id", document.id);

    const { data: blob, error: downloadError } = await supabase.storage
      .from("documents")
      .download(document.file_path);
    if (downloadError || !blob) {
      throw new Error("Unable to download the source file.");
    }

    const file = new File([blob], document.title, {
      type: document.mime_type ?? blob.type,
    });
    const extracted = await extractDocumentFromFile(file);
    if (!extracted.text.trim()) {
      throw new Error("No extractable text was found in this document.");
    }
    if (extracted.text.length > MAX_EXTRACTED_TEXT_CHARS) {
      throw new Error("Extracted text exceeds the 2,000,000 character processing limit.");
    }

    const chunks = chunkTextWithMetadata(extracted.text, { pages: extracted.pages });
    if (chunks.length === 0) {
      throw new Error("No searchable chunks could be created from this document.");
    }

    const contentHash = sha256(extracted.text);
    const records: Array<Record<string, unknown>> = [];
    let embeddingTokens = 0;

    for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const embeddingResponse = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch.map((chunk) =>
          buildEmbeddingInputText(document.title, document.mime_type, chunk.content),
        ),
      });
      embeddingTokens += embeddingResponse.usage.total_tokens;

      if (embeddingResponse.data.length !== batch.length) {
        throw new Error("Embedding provider returned an incomplete batch.");
      }

      records.push(
        ...batch.map((chunk, index) => ({
          document_id: document.id,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          embedding: embeddingResponse.data[index].embedding,
          token_count: chunk.tokenCount,
          char_start: chunk.charStart,
          char_end: chunk.charEnd,
          page_start: chunk.pageStart,
          page_end: chunk.pageEnd,
          content_hash: sha256(chunk.content),
          embedding_model: EMBEDDING_MODEL,
        })),
      );
    }

    // A retry may follow a partial insert. Replacing all derived chunks makes the
    // operation idempotent while preserving the raw source object.
    const { error: deleteChunksError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", document.id);
    if (deleteChunksError) throw deleteChunksError;

    for (let offset = 0; offset < records.length; offset += 250) {
      const { error: insertError } = await supabase
        .from("document_chunks")
        .insert(records.slice(offset, offset + 250));
      if (insertError) throw insertError;
    }

    // Concepts are derived from the chunks that were just stored, so this runs
    // after the insert and before the job is released — the ownership fence
    // still protects it. It is deliberately non-fatal: search and Ask depend on
    // chunks and embeddings, not on the concept graph, so a concept failure
    // must never keep a document out of the knowledge base.
    await runConceptStage(supabase, {
      userId: document.user_id,
      documentId: document.id,
      documentTitle: document.title,
      jobId: job.id,
    });

    // Release the job before the document so that losing the fence leaves the
    // document untouched rather than half-updated by a worker that no longer
    // owns the work.
    const released = await releaseJob(supabase, job, {
      status: "completed",
      last_error: null,
    });
    if (!released) {
      console.warn("Ingestion job was reclaimed mid-run; discarding result", { jobId: job.id });
      return { status: "superseded" as const, documentId: job.document_id };
    }

    const { error: documentUpdateError } = await supabase
      .from("documents")
      .update({
        status: "ready",
        content_hash: contentHash,
        embedding_model: EMBEDDING_MODEL,
        processed_at: new Date().toISOString(),
        extraction_error: null,
      })
      .eq("id", document.id);
    if (documentUpdateError) throw documentUpdateError;

    await recordAiUsage(supabase, {
      userId: document.user_id,
      operation: "upload",
      model: EMBEDDING_MODEL,
      inputTokens: embeddingTokens,
      latencyMs: Date.now() - startedAt,
    });

    await recordObservation(supabase, {
      userId: document.user_id,
      eventType: "document_processed",
      sourceId: document.id,
      context: { documentId: document.id, jobId: job.id },
      payload: {
        title: document.title,
        chunkCount: records.length,
        embeddingModel: EMBEDDING_MODEL,
        embeddingTokens,
        durationMs: Date.now() - startedAt,
      },
      // A re-ingest of unchanged content must not append a second "processed"
      // event; a genuine re-process of changed content should.
      dedupeKey: `document_processed:${document.id}:${contentHash}`,
    });

    return { status: "completed" as const, documentId: document.id };
  } catch (error) {
    const message = toSafeErrorMessage(error);
    const retry = job.attempts < job.max_attempts;
    const retryAt = new Date(Date.now() + Math.min(2 ** job.attempts, 30) * 60_000).toISOString();

    const released = await releaseJob(supabase, job, {
      status: retry ? "retry" : "failed",
      run_after: retry ? retryAt : new Date().toISOString(),
      last_error: message,
    });
    if (!released) {
      console.warn("Ingestion job was reclaimed before its failure was recorded", { jobId: job.id });
      return { status: "superseded" as const, documentId: job.document_id };
    }

    await supabase
      .from("documents")
      .update({
        status: retry ? "pending" : "failed",
        extraction_error: retry ? null : message,
      })
      .eq("id", job.document_id);

    await recordObservation(supabase, {
      userId: job.user_id,
      eventType: "document_processing_failed",
      sourceId: job.document_id,
      context: { documentId: job.document_id, jobId: job.id },
      payload: {
        title: documentTitle ?? "Unknown document",
        reason: message,
        attempt: job.attempts,
        willRetry: retry,
      },
      dedupeKey: `document_processing_failed:${job.id}:${job.attempts}`,
    });

    console.error("Ingestion job failed", { jobId: job.id, documentId: job.document_id, message });
    return { status: retry ? ("retry" as const) : ("failed" as const), documentId: job.document_id };
  }
}

/**
 * Derives and stores the document's concept graph.
 *
 * Never throws. A failure is recorded as an observation and the ingestion
 * continues, so the document still reaches `ready` with working search.
 */
export async function runConceptStage(
  supabase: SupabaseClient,
  {
    userId,
    documentId,
    documentTitle,
    jobId,
  }: { userId: string; documentId: string; documentTitle: string; jobId: string },
) {
  try {
    const chunks = await loadConceptSourceChunks(supabase, documentId);
    if (chunks.length === 0) return;

    const summary = await syncDocumentConcepts(supabase, {
      userId,
      documentId,
      documentTitle,
      chunks,
    });

    // Detection runs where the evidence changes, not when the user opens a
    // page: a Server Component render should not be mutating, and a notice
    // should already exist by the time anyone looks.
    const { error: noticeError } = await supabase.rpc("detect_notices", {
      target_user_id: userId,
    });
    if (noticeError) console.error("Notice detection failed", noticeError);

    await recordObservation(supabase, {
      userId,
      eventType: "concepts_extracted",
      sourceId: documentId,
      context: { documentId, jobId },
      payload: {
        title: documentTitle,
        conceptCount: summary.candidateCount,
        mentionCount: summary.mentionsWritten,
        newConceptCount: summary.conceptsCreated,
        encountersRecorded: summary.encountersRecorded,
        chunksAnalyzed: summary.chunksAnalyzed,
        chunksSkipped: summary.chunksSkipped,
        rejectedMentions: summary.rejectedMentions,
        model: summary.model,
        durationMs: summary.durationMs,
        concepts: summary.topConcepts,
      },
    });
  } catch (error) {
    // The document itself ingested fine, so the reason must not read as though
    // processing failed.
    const reason = toSafeErrorMessage(error, "Concept extraction failed.");
    console.error("Concept extraction failed", { documentId, reason });
    await recordObservation(supabase, {
      userId,
      eventType: "concept_extraction_failed",
      sourceId: documentId,
      context: { documentId, jobId },
      payload: { title: documentTitle, reason },
    });
  }
}

/**
 * Releases a claimed job, but only if this worker still holds it.
 *
 * `locked_by` plus `locked_at` act as a fencing token. A worker that stalled
 * long enough to be reclaimed by `reclaim_stale_ingestion_jobs` will match zero
 * rows here, so it cannot overwrite the state of the run that replaced it.
 */
async function releaseJob(
  supabase: SupabaseClient,
  job: IngestionJob,
  update: Record<string, unknown>,
) {
  let query = supabase
    .from("ingestion_jobs")
    .update({ ...update, locked_at: null, locked_by: null })
    .eq("id", job.id)
    .eq("status", "processing");

  if (job.locked_by !== null) query = query.eq("locked_by", job.locked_by);
  if (job.locked_at !== null) query = query.eq("locked_at", job.locked_at);

  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Returns jobs abandoned by a worker that never released its lock.
 *
 * Runs before every claim pass so a crashed run self-heals on the next worker
 * cycle instead of leaving the document permanently stuck in `processing`.
 */
export async function reclaimStaleIngestionJobs(staleAfterSeconds = STALE_JOB_SECONDS) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return [];
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("reclaim_stale_ingestion_jobs", {
    stale_after_seconds: staleAfterSeconds,
    batch_size: 25,
  });
  if (error) throw error;

  const reclaimed = (data ?? []) as Array<{ id: string; document_id: string; status: string }>;
  if (reclaimed.length > 0) {
    console.warn("Reclaimed stale ingestion jobs", { count: reclaimed.length });
  }
  return reclaimed;
}

export async function processQueuedIngestionJobs(workerName: string, batchSize = 3) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Skipping ingestion processing: SUPABASE_SERVICE_ROLE_KEY is not set in environment.");
    return [];
  }
  const supabase = createAdminClient();

  // Recovery before claiming: a reclaimed job returns to 'retry' and is
  // eligible for the claim below in the same pass.
  try {
    await reclaimStaleIngestionJobs();
  } catch (error) {
    // Recovery is best-effort. Failing it must not stop healthy jobs running.
    console.error("Stale ingestion job reclaim failed", error);
  }

  const { data, error } = await supabase.rpc("claim_ingestion_jobs", {
    worker_name: workerName,
    batch_size: batchSize,
  });
  if (error) throw error;

  const jobs = (data ?? []) as IngestionJob[];
  return Promise.all(jobs.map((job) => processClaimedIngestionJob(job)));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toSafeErrorMessage(error: unknown, fallback = "Document processing failed.") {
  // Supabase rejects with a plain `{ message, code, ... }` object rather than an
  // Error, so an `instanceof` check alone would discard every database reason
  // and report the fallback instead.
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : fallback;
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

export function buildEmbeddingInputText(title: string, mimeType: string | null, content: string): string {
  const header = `Document Title: ${title}${mimeType ? ` (${mimeType})` : ""}`;
  return `${header}\n\n${content}`;
}
