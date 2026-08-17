import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimEvidenceRecord,
  ClaimStatus,
  ClaimType,
  UserClaim,
} from "@/lib/claims/types";

const CLAIM_COLUMNS =
  "id, claim_type, asserted_by, statement, status, confidence, confidence_method, valid_from, valid_to, first_stated_at, last_stated_at, evidence_count, inference_rule, inference_min_evidence";

/**
 * Reads the user's claims.
 *
 * Scoping is enforced by RLS on `user_claims`; passing a user-scoped client is
 * what makes this safe.
 */
export async function listUserClaims(
  supabase: SupabaseClient,
  { statuses = ["active"], limit = 100 }: { statuses?: ClaimStatus[]; limit?: number } = {},
): Promise<{ claims: UserClaim[]; error?: string }> {
  const { data, error } = await supabase
    .from("user_claims")
    .select(CLAIM_COLUMNS)
    .in("status", statuses)
    .order("last_stated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));

  if (error) {
    console.error("[claims] list failed:", error.message);
    return { claims: [], error: error.message };
  }
  return { claims: (data ?? []).map(toUserClaim) };
}

/** Evidence for a set of claims, for the inspection UI's "why" view. */
export async function listClaimEvidence(
  supabase: SupabaseClient,
  claimIds: string[],
): Promise<{ evidence: ClaimEvidenceRecord[]; error?: string }> {
  if (claimIds.length === 0) return { evidence: [] };

  const { data, error } = await supabase
    .from("claim_evidence")
    .select("id, claim_id, observation_id, relation, excerpt, source_message_id, occurred_at")
    .in("claim_id", claimIds)
    .order("occurred_at", { ascending: false });

  if (error) {
    console.error("[claims] evidence lookup failed:", error.message);
    return { evidence: [], error: error.message };
  }

  return {
    evidence: (data ?? []).map((row) => ({
      id: row.id as string,
      claimId: row.claim_id as string,
      observationId: row.observation_id as string,
      relation: row.relation as ClaimEvidenceRecord["relation"],
      excerpt: (row.excerpt as string | null) ?? null,
      sourceMessageId: (row.source_message_id as string | null) ?? null,
      occurredAt: row.occurred_at as string,
    })),
  };
}

export function toUserClaim(row: Record<string, unknown>): UserClaim {
  return {
    id: row.id as string,
    claimType: row.claim_type as ClaimType,
    assertedBy: row.asserted_by as UserClaim["assertedBy"],
    statement: row.statement as string,
    status: row.status as ClaimStatus,
    confidence: Number(row.confidence ?? 1),
    confidenceMethod: row.confidence_method as string,
    validFrom: row.valid_from as string,
    validTo: (row.valid_to as string | null) ?? null,
    firstStatedAt: row.first_stated_at as string,
    lastStatedAt: row.last_stated_at as string,
    evidenceCount: Number(row.evidence_count ?? 0),
    inferenceRule: (row.inference_rule as string | null) ?? null,
    inferenceMinEvidence:
      row.inference_min_evidence === null || row.inference_min_evidence === undefined
        ? null
        : Number(row.inference_min_evidence),
  };
}

/**
 * Runs the inference pass for the signed-in user.
 *
 * Never throws: an inference failing must not break the page that triggered it.
 */
export async function refreshInferences(supabase: SupabaseClient) {
  const { error } = await supabase.rpc("refresh_my_inferences");
  if (error) {
    console.error("[claims] inference refresh failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
