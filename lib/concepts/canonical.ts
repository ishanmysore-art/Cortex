/**
 * Concept identity.
 *
 * `canonicalKey` is the deterministic half of deduplication and backs a unique
 * constraint, so it is the hard guarantee that one idea does not become three
 * rows. The extractor supplies a canonical *label* (expanding "ADHD" to its full
 * name, singularising, dropping articles); this reduces that label to a stable
 * key by removing everything that is presentation rather than identity.
 */

export const MAX_CONCEPT_LABEL_CHARS = 120;
export const MIN_CONCEPT_LABEL_CHARS = 2;

/**
 * Document-structure words that describe where text sits rather than what it is
 * about. They are the most common junk output of any extractor and would
 * otherwise become high-degree hub concepts connected to everything.
 *
 * Deliberately limited to structural terms. Contentful-but-generic words like
 * "data" or "study" are left in, because whether they are noise depends on the
 * corpus and silently dropping them would be a judgement this layer cannot make.
 */
const STRUCTURAL_TERMS = new Set([
  "abstract",
  "acknowledgements",
  "appendix",
  "bibliography",
  "chapter",
  "conclusion",
  "conclusions",
  "discussion",
  "figure",
  "figures",
  "introduction",
  "method",
  "methods",
  "methodology",
  "references",
  "results",
  "section",
  "supplementary",
  "table",
  "tables",
]);

/**
 * Reduces a label to its identity key.
 *
 * Deliberately does no stemming or singularisation. Naive suffix stripping turns
 * "bias" into "bia" and "analysis" into "analysi", which invents collisions
 * between unrelated concepts — a far worse failure than the occasional
 * singular/plural split, which the embedding fallback in `sync_document_concepts`
 * is there to catch.
 */
export function canonicalizeConceptLabel(label: string): string {
  return label
    .normalize("NFKD")
    // Strip combining marks so "naïve" and "naive" are one concept.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Possessives carry no identity: "Bayes' theorem" is "bayes theorem".
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    // Hyphens, slashes, and punctuation all collapse to a single separator.
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NormalizedConceptLabel = {
  label: string;
  canonicalKey: string;
};

/**
 * Validates and normalises one extracted label, or returns null to drop it.
 *
 * Rejecting here rather than at the database boundary keeps malformed model
 * output from ever reaching the graph.
 */
export function normalizeConceptLabel(raw: unknown): NormalizedConceptLabel | null {
  if (typeof raw !== "string") return null;

  const label = raw.replace(/\s+/g, " ").trim();
  if (label.length < MIN_CONCEPT_LABEL_CHARS || label.length > MAX_CONCEPT_LABEL_CHARS) {
    return null;
  }

  const canonicalKey = canonicalizeConceptLabel(label);
  if (canonicalKey.length < MIN_CONCEPT_LABEL_CHARS) return null;
  // A concept needs at least one letter: "2024" and "3.5" are values, not ideas.
  if (!/[a-z]/.test(canonicalKey)) return null;
  if (STRUCTURAL_TERMS.has(canonicalKey)) return null;

  return { label, canonicalKey };
}

export function isStructuralTerm(canonicalKey: string) {
  return STRUCTURAL_TERMS.has(canonicalKey);
}
