import { DocumentUpload } from "@/components/app/document-upload";
import { createClient } from "@/lib/supabase/server";
import { DocumentList } from "@/components/app/document-list";

/** Chips shown per document. Enough to recognise the material, not a graph view. */
const CONCEPTS_PER_DOCUMENT = 6;

export default async function NotesPage() {
  const supabase = await createClient();
  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: false });

  // `document_concepts` is a security_invoker view, so RLS on the underlying
  // tables scopes this to the signed-in user.
  const { data: conceptRows } = await supabase
    .from("document_concepts")
    .select("document_id, concept_id, label, mention_count")
    .order("mention_count", { ascending: false })
    .limit(400);

  const conceptsByDocument: Record<
    string,
    Array<{ id: string; label: string; mentionCount: number }>
  > = {};
  for (const row of conceptRows ?? []) {
    const documentId = row.document_id as string;
    const existing = conceptsByDocument[documentId] ?? [];
    if (existing.length >= CONCEPTS_PER_DOCUMENT) continue;
    existing.push({
      id: row.concept_id as string,
      label: row.label as string,
      mentionCount: row.mention_count as number,
    });
    conceptsByDocument[documentId] = existing;
  }

  return (
    <>
      <header className="border-b border-border/60 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Notes</h1>
      </header>

      <main className="p-6 max-w-4xl mx-auto space-y-8">
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-4">Upload New Document</h2>
          <DocumentUpload />
        </section>

        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-4">Your Documents</h2>
          <DocumentList documents={documents ?? []} conceptsByDocument={conceptsByDocument} />
        </section>
      </main>
    </>
  );
}
