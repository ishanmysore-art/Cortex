"use client";

import { useRef, useState, useTransition } from "react";
import { Search, Loader2, AlertCircle } from "lucide-react";
import { searchNotes, SearchResult } from "@/app/actions/search";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchResultCard } from "@/components/app/search-result-card";

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "results"; results: SearchResult[]; query: string }
  | { status: "error"; message: string };

export function SearchBar() {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const query = inputRef.current?.value?.trim();
    if (!query) return;

    setState({ status: "searching" });

    startTransition(async () => {
      const { results, error } = await searchNotes(query);

      if (error) {
        setState({ status: "error", message: error });
      } else {
        setState({ status: "results", results: results ?? [], query });
      }
    });
  }

  const isSearching = state.status === "searching" || isPending;

  return (
    <div className="flex flex-col gap-8">
      {/* Search form */}
      <form onSubmit={handleSubmit} role="search" aria-label="Search your notes">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              id="search-input"
              name="query"
              type="search"
              placeholder="Ask anything — e.g. 'what did I note about sleep?'"
              className="pl-9"
              disabled={isSearching}
              autoComplete="off"
              autoFocus
            />
          </div>
          <Button
            id="search-submit"
            type="submit"
            disabled={isSearching}
            aria-label={isSearching ? "Searching…" : "Search"}
          >
            {isSearching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Search"
            )}
          </Button>
        </div>
      </form>

      {/* Results area */}
      {state.status === "error" && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{state.message}</span>
        </div>
      )}

      {state.status === "results" && state.results.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm font-medium text-foreground">No results found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try rephrasing your query, or upload more notes.
          </p>
        </div>
      )}

      {state.status === "results" && state.results.length > 0 && (
        <section aria-label="Search results">
          <p className="mb-4 text-xs text-muted-foreground">
            {state.results.length} result
            {state.results.length !== 1 ? "s" : ""} for{" "}
            <span className="font-medium text-foreground">
              &ldquo;{state.query}&rdquo;
            </span>
          </p>
          <div className="grid gap-3">
            {state.results.map((result) => (
              <SearchResultCard
                key={result.id}
                result={result}
                documentTitle={result.document_title}
                documentFileType={result.document_file_type}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
