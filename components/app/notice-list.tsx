"use client";

import { useState, useTransition } from "react";
import { Check, Lightbulb, X } from "lucide-react";
import { acceptNotice, dismissNotice } from "@/app/actions/notices";
import { Button } from "@/components/ui/button";

export type NoticeItem = {
  id: string;
  kind: string;
  confidenceMethod: string;
  response: string;
};

const KIND_LABELS: Record<string, string> = {
  concept_connection: "Ideas that travel together",
  recurring_concept: "Keeps coming up",
};

function NoticeRow({ notice }: { notice: NoticeItem }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isAnswered = notice.response !== "pending";

  function run(action: (id: string) => Promise<{ error?: string } | { success: true }>) {
    setError(null);
    startTransition(async () => {
      const result = await action(notice.id);
      if ("error" in result && typeof result.error === "string") setError(result.error);
    });
  }

  return (
    <article
      className={`rounded-xl border border-border bg-card p-4 ${isPending ? "opacity-50" : ""}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Lightbulb className="h-3 w-3" />
            {KIND_LABELS[notice.kind] ?? notice.kind}
          </p>
          {/* The notice IS its evidence: a counted statement about the user's
              own material, not a conclusion drawn from it. */}
          <p className="text-sm leading-relaxed">{notice.confidenceMethod}.</p>
          {isAnswered && (
            <p className="mt-1.5 text-xs text-muted-foreground">Kept</p>
          )}
        </div>

        {!isAnswered && (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" disabled={isPending} onClick={() => run(acceptNotice)}>
              <Check className="mr-1.5 h-3.5 w-3.5" /> Useful
            </Button>
            <Button variant="secondary" size="sm" disabled={isPending} onClick={() => run(dismissNotice)}>
              <X className="mr-1.5 h-3.5 w-3.5" /> Not useful
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </article>
  );
}

export function NoticeList({ notices }: { notices: NoticeItem[] }) {
  if (notices.length === 0) return null;

  return (
    <div className="grid gap-3">
      {notices.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
