"use client";

import { useState, useTransition } from "react";
import { Archive, RotateCcw, Undo2 } from "lucide-react";
import { archiveClaim, restoreClaim, retractClaim } from "@/app/actions/claims";
import { Button } from "@/components/ui/button";

type Evidence = {
  id: string;
  excerpt: string | null;
  occurredAt: string;
};

export type ClaimListItem = {
  id: string;
  claimType: string;
  assertedBy: "user" | "cortex";
  confidence: number;
  confidenceMethod: string;
  statement: string;
  status: string;
  firstStatedAt: string;
  lastStatedAt: string;
  evidenceCount: number;
  evidence: Evidence[];
};

const TYPE_LABELS: Record<string, string> = {
  belief: "Belief",
  goal: "Goal",
  interest: "Interest",
  preference: "Preference",
  open_question: "Open question",
  hypothesis: "Hypothesis",
  self_description: "Self-description",
  note: "Note",
  sustained_interest: "Recurring theme",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function ClaimRow({ claim }: { claim: ClaimListItem }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isClosed = claim.status !== "active";
  const isInferred = claim.assertedBy === "cortex";

  function run(action: (id: string) => Promise<{ error?: string } | { success: true }>) {
    setError(null);
    startTransition(async () => {
      const result = await action(claim.id);
      if ("error" in result && typeof result.error === "string") setError(result.error);
    });
  }

  return (
    <article
      className={`rounded-xl border bg-card p-4 ${
        isInferred ? "border-dashed border-border" : "border-border"
      } ${isPending ? "opacity-50" : ""}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* An inferred claim must never be mistaken for something the user
              said, so it is labelled before it is read. */}
          {isInferred && (
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Cortex inferred this · {Math.round(claim.confidence * 100)}% confidence
            </p>
          )}
          <p className="text-sm leading-relaxed">{claim.statement}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {TYPE_LABELS[claim.claimType] ?? claim.claimType} ·{" "}
            {isInferred ? "From statements since " : "Stated "}
            {formatDate(claim.firstStatedAt)}
            {!isInferred && claim.evidenceCount > 1 && ` · Said ${claim.evidenceCount} times`}
            {isClosed && ` · ${claim.status === "unsupported" ? "no longer enough evidence" : claim.status}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {isClosed ? (
            <Button variant="secondary" size="sm" disabled={isPending} onClick={() => run(restoreClaim)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restore
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" disabled={isPending} onClick={() => run(archiveClaim)}>
                <Archive className="mr-1.5 h-3.5 w-3.5" /> Archive
              </Button>
              <Button variant="secondary" size="sm" disabled={isPending} onClick={() => run(retractClaim)}>
                <Undo2 className="mr-1.5 h-3.5 w-3.5" /> {isInferred ? "Reject" : "Not me"}
              </Button>
            </>
          )}
        </div>
      </div>

      {(claim.evidence.length > 0 || isInferred) && (
        <details className="mt-3 rounded-lg border border-border/70 bg-surface/40 p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            Why Cortex has this ({claim.evidenceCount})
          </summary>
          {/* The reasoning is a sentence built from the evidence counts, not an
              opaque score, so it can be checked rather than trusted. */}
          {isInferred && (
            <p className="mt-2 text-muted-foreground">{claim.confidenceMethod}</p>
          )}
          <ul className="mt-2 space-y-2">
            {claim.evidence.map((item) => (
              <li key={item.id} className="text-muted-foreground">
                <span className="block text-[11px] uppercase tracking-wide">
                  You wrote · {formatDate(item.occurredAt)}
                </span>
                {item.excerpt && <q className="mt-0.5 block italic">{item.excerpt}</q>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </article>
  );
}

export function ClaimList({ claims }: { claims: ClaimListItem[] }) {
  if (claims.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/10 p-8 text-center text-sm text-muted-foreground">
        Cortex has not recorded anything you have explicitly said about your own thinking yet.
        Statements like &ldquo;I think…&rdquo;, &ldquo;I want to…&rdquo;, or &ldquo;I&rsquo;m
        trying to understand…&rdquo; in Ask are what it picks up.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {claims.map((claim) => (
        <ClaimRow key={claim.id} claim={claim} />
      ))}
    </div>
  );
}
