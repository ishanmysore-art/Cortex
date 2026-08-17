// Env is loaded via --env-file .env.local when invoking with tsx
import { createAdminClient } from "@/lib/supabase/admin";
import { processQueuedIngestionJobs } from "@/lib/ingestion/processor";

async function main() {
  console.log("Starting re-ingestion of existing documents...");
  const supabase = createAdminClient();

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, user_id, title");

  if (error) {
    console.error("Failed to list documents:", error);
    process.exit(1);
  }

  if (!documents || documents.length === 0) {
    console.log("No documents found in the database.");
    return;
  }

  console.log(`Found ${documents.length} document(s) to re-ingest:`);
  for (const doc of documents) {
    console.log(`- ${doc.title} (${doc.id})`);

    // Reset document status
    await supabase
      .from("documents")
      .update({ status: "pending", extraction_error: null })
      .eq("id", doc.id);

    // Delete any existing ingestion job for this document (completed, failed, queued etc.)
    // so we can insert a fresh queued job that claim_ingestion_jobs will pick up.
    await supabase.from("ingestion_jobs").delete().eq("document_id", doc.id);

    const { error: insertError } = await supabase.from("ingestion_jobs").insert({
      user_id: doc.user_id,
      document_id: doc.id,
      status: "queued",
      attempts: 0,
      max_attempts: 3,
      run_after: new Date().toISOString(),
    });
    if (insertError) {
      console.error(`Failed to enqueue ${doc.title}:`, insertError.message);
    }
  }

  console.log("\nProcessing enqueued ingestion jobs (this may take several minutes)...");
  const results = await processQueuedIngestionJobs("script-reingest-worker", documents.length);
  console.log("Re-ingestion results:");
  for (const result of results) {
    console.log(` - documentId=${result.documentId} status=${result.status}`);
  }
  console.log("Re-ingestion complete!");
}

main().catch((err) => {
  console.error("Re-ingestion script failed:", err);
  process.exit(1);
});
