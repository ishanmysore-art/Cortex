import { after } from "next/server";
import { ClaimList, type ClaimListItem } from "@/components/app/claim-list";
import { KnowledgeStateList } from "@/components/app/knowledge-state-list";
import { NoticeList } from "@/components/app/notice-list";
import { listClaimEvidence, listUserClaims } from "@/lib/claims";
import { listKnowledgeStates } from "@/lib/knowledge";
import { listNotices, markNoticesSurfaced } from "@/lib/notices";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Your model — Cortex",
  description: "What Cortex has recorded you explicitly saying, and the evidence for it.",
};

/** Evidence entries shown per claim. Enough to justify it, not a full history. */
const EVIDENCE_PER_CLAIM = 3;

export default async function ModelPage() {
  const supabase = await createClient();

  const { claims } = await listUserClaims(supabase, {
    statuses: ["active", "archived", "retracted", "unsupported"],
    limit: 200,
  });
  const { evidence } = await listClaimEvidence(
    supabase,
    claims.map((claim) => claim.id),
  );
  const { states } = await listKnowledgeStates(supabase, { limit: 50 });
  const { notices } = await listNotices(supabase);

  // Recorded after the response, because "the user saw it" is a different fact
  // from "Cortex detected it" and only the pair makes a dismissal meaningful.
  if (notices.some((notice) => notice.response === "pending")) {
    after(() => markNoticesSurfaced(supabase));
  }

  const evidenceByClaim = new Map<string, ClaimListItem["evidence"]>();
  for (const item of evidence) {
    const existing = evidenceByClaim.get(item.claimId) ?? [];
    if (existing.length >= EVIDENCE_PER_CLAIM) continue;
    existing.push({ id: item.id, excerpt: item.excerpt, occurredAt: item.occurredAt });
    evidenceByClaim.set(item.claimId, existing);
  }

  const items: ClaimListItem[] = claims.map((claim) => ({
    id: claim.id,
    claimType: claim.claimType,
    statement: claim.statement,
    status: claim.status,
    firstStatedAt: claim.firstStatedAt,
    lastStatedAt: claim.lastStatedAt,
    assertedBy: claim.assertedBy,
    confidence: claim.confidence,
    confidenceMethod: claim.confidenceMethod,
    evidenceCount: claim.evidenceCount,
    evidence: evidenceByClaim.get(claim.id) ?? [],
  }));

  const active = items.filter((item) => item.status === "active" && item.assertedBy === "user");
  const inferred = items.filter((item) => item.status === "active" && item.assertedBy === "cortex");
  const closed = items.filter((item) => item.status !== "active");

  return (
    <>
      <header className="border-b border-border/60 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Your model</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What Cortex has recorded you explicitly saying, and the evidence for each. Nothing here
          is inferred — if something is wrong, remove it.
        </p>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-8 p-6">
        {notices.length > 0 && (
          <section>
            <h2 className="mb-1 text-sm font-medium text-muted-foreground">
              Cortex noticed ({notices.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Counted patterns in your own material — not conclusions about what you know.
              Telling Cortex a notice was not useful removes it for good.
            </p>
            <NoticeList
              notices={notices.map((notice) => ({
                id: notice.id,
                kind: notice.kind,
                confidenceMethod: notice.confidenceMethod,
                response: notice.response,
              }))}
            />
          </section>
        )}

        <section>
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">
            Currently held ({active.length})
          </h2>
          <ClaimList claims={active} />
        </section>

        {inferred.length > 0 && (
          <section>
            <h2 className="mb-1 text-sm font-medium text-muted-foreground">
              What Cortex has inferred ({inferred.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Cortex worked these out from things you said on separate occasions — you did not
              state them directly. Each shows the reasoning and the statements behind it. Reject
              anything wrong; a rejection is permanent and Cortex will not infer it again.
            </p>
            <ClaimList claims={inferred} />
          </section>
        )}

        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">
            Ideas in your material ({states.length})
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            How often each idea appears in what you have added, and how often Cortex has cited it
            when answering you. Counts only — Cortex draws no conclusion from these about how well
            you know anything.
          </p>
          <KnowledgeStateList states={states} />
        </section>

        {closed.length > 0 && (
          <section>
            <h2 className="mb-4 text-sm font-medium text-muted-foreground">
              No longer held ({closed.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Kept on purpose. That your thinking changed is part of your intellectual history.
            </p>
            <ClaimList claims={closed} />
          </section>
        )}
      </main>
    </>
  );
}
