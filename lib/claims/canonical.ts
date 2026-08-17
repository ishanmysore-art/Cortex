/**
 * Claim identity.
 *
 * Deliberately conservative: only statements that normalise to the exact same
 * key are treated as the same claim. Two differently-worded statements stay
 * separate even when they plausibly mean the same thing.
 *
 * That asymmetry is intentional. A duplicate claim is visible and mergeable
 * later; an incorrect merge silently destroys the record of a distinction the
 * user actually drew, and there is no way to recover it.
 */

import {
  MAX_CLAIM_STATEMENT_CHARS,
  MIN_CLAIM_STATEMENT_CHARS,
} from "@/lib/claims/types";

/**
 * Normalises presentation without touching meaning: case, accents, punctuation,
 * and whitespace only. No stemming and no stop-word removal — both would merge
 * statements whose difference is the whole point ("I think X" vs "I no longer
 * think X" must never collapse).
 */
export function canonicalizeClaimStatement(statement: string): string {
  return statement
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLAIM_STATEMENT_CHARS);
}

export type NormalizedClaimStatement = {
  statement: string;
  canonicalKey: string;
};

export function normalizeClaimStatement(raw: unknown): NormalizedClaimStatement | null {
  if (typeof raw !== "string") return null;

  const statement = raw.replace(/\s+/g, " ").trim();
  if (
    statement.length < MIN_CLAIM_STATEMENT_CHARS ||
    statement.length > MAX_CLAIM_STATEMENT_CHARS
  ) {
    return null;
  }

  const canonicalKey = canonicalizeClaimStatement(statement);
  if (canonicalKey.length < MIN_CLAIM_STATEMENT_CHARS) return null;
  if (!/[a-z]/.test(canonicalKey)) return null;

  return { statement, canonicalKey };
}
