"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  File,
  CheckCircle2,
  Clock,
  XCircle,
  Trash2,
  Loader2,
} from "lucide-react";
import { deleteDocument } from "@/app/actions/documents";

interface Document {
  id: string;
  title: string;
  file_type: string;
  status: string;
  created_at: string;
  extraction_error?: string | null;
}

interface DocumentConcept {
  id: string;
  label: string;
  mentionCount: number;
}

interface DocumentListProps {
  documents: Document[];
  conceptsByDocument?: Record<string, DocumentConcept[]>;
}

function DocumentRow({ doc, concepts }: { doc: Document; concepts: DocumentConcept[] }) {
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (
      !window.confirm(
        `Delete "${doc.title}"?\n\nThis will permanently remove the file and all its chunks.`
      )
    ) {
      return;
    }

    startTransition(async () => {
      await deleteDocument(doc.id);
    });
  }

  return (
    <div
      className={`flex flex-col gap-3 sm:flex-row sm:items-center justify-between p-4 border rounded-lg bg-card transition-opacity ${
        isPending ? "opacity-50 pointer-events-none" : ""
      }`}
    >
      {/* Left — icon + metadata */}
      <div className="flex items-center space-x-4 min-w-0">
        <div className="shrink-0 p-2 bg-primary/10 rounded-md text-primary">
          {doc.file_type === "pdf" ? (
            <File className="w-5 h-5" />
          ) : (
            <FileText className="w-5 h-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate">{doc.title}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(doc.created_at).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
          {doc.status === "failed" && doc.extraction_error && (
            <p className="mt-1 max-w-md text-xs text-red-600 break-words" title={doc.extraction_error}>
              {doc.extraction_error}
            </p>
          )}
          {concepts.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Concepts in ${doc.title}`}>
              {concepts.map((concept) => (
                <li
                  key={concept.id}
                  className="rounded-full border border-border/70 bg-surface/60 px-2 py-0.5 text-xs text-muted-foreground"
                  title={`${concept.mentionCount} mention${concept.mentionCount === 1 ? "" : "s"} in this document`}
                >
                  {concept.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right — status + delete */}
      <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 border-t border-border/40 sm:pt-0 sm:border-t-0">
        <div className="flex items-center gap-1.5" role="status" aria-label={`Document status: ${doc.status}`}>
          {doc.status === "ready" && (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          )}
          {(doc.status === "processing" || doc.status === "pending") && (
            <Clock className="w-4 h-4 text-yellow-500" />
          )}
          {doc.status === "failed" && (
            <XCircle className="w-4 h-4 text-red-500" />
          )}
          <span className="text-xs capitalize text-muted-foreground">
            {doc.status}
          </span>
        </div>

        <button
          id={`delete-doc-${doc.id}`}
          onClick={handleDelete}
          disabled={isPending}
          aria-label={`Delete ${doc.title}`}
          title="Delete document"
          className="p-1.5 rounded-md text-muted-foreground transition-colors hover:text-red-500 hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

export function DocumentList({ documents, conceptsByDocument = {} }: DocumentListProps) {
  const router = useRouter();
  const hasProcessingDocs = documents.some(
    (doc) => doc.status === "pending" || doc.status === "processing"
  );

  useEffect(() => {
    if (!hasProcessingDocs) return;
    const timer = setInterval(() => {
      router.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [hasProcessingDocs, router]);

  if (documents.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-8 border rounded-lg bg-muted/10 text-center">
        No documents yet. Upload one above to get started.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {documents.map((doc) => (
        <DocumentRow key={doc.id} doc={doc} concepts={conceptsByDocument[doc.id] ?? []} />
      ))}
    </div>
  );
}
