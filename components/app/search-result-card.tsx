import { FileText, File } from "lucide-react";

interface SearchResultCardProps {
  result: {
    id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    similarity: number;
    page_start?: number | null;
    page_end?: number | null;
  };
  documentTitle: string;
  documentFileType: string;
}

export function SearchResultCard({
  result,
  documentTitle,
  documentFileType,
}: SearchResultCardProps) {
  const relevancePercent = Math.round(result.similarity * 100);

  // Colour-code the relevance badge
  const badgeClass =
    relevancePercent >= 80
      ? "bg-green-500/10 text-green-600"
      : relevancePercent >= 60
      ? "bg-yellow-500/10 text-yellow-600"
      : "bg-muted text-muted-foreground";

  return (
    <article className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20 hover:bg-surface">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-muted-foreground">
            {documentFileType === "pdf" ? (
              <File className="h-4 w-4" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </span>
          <span className="truncate text-sm font-medium text-foreground">
            {documentTitle}
          </span>
          {result.page_start && (
            <span className="shrink-0 text-xs text-muted-foreground">
              · p. {result.page_start}{result.page_end && result.page_end !== result.page_start ? `–${result.page_end}` : ""}
            </span>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass}`}
        >
          {relevancePercent}% match
        </span>
      </div>

      {/* Content excerpt */}
      <p className="text-sm leading-relaxed text-muted-foreground line-clamp-4">
        {result.content}
      </p>
    </article>
  );
}
