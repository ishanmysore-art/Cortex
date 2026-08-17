import type { SupabaseClient } from "@supabase/supabase-js";
import type { ObservationInput } from "@/lib/observations";

/** Keeps the enriched payload well inside the observation size limit. */
export const MAX_ATTRIBUTED_CONCEPTS = 25;

/**
 * Stamps cited passages with the concepts they carried.
 *
 * Runs at citation time on purpose. Resolving a citation to a concept later
 * means joining through `concept_mentions`, which cascades away with its
 * document — so deleting a document used to erase its own retrieval history.
 * Capturing the attribution while the mentions still exist makes it durable.
 *
 * Mutates the payloads in place and never throws: attribution is an enrichment,
 * and losing it must not cost the observation itself.
 */
export async function attachConceptAttribution(
  supabase: SupabaseClient,
  observations: ObservationInput[],
): Promise<void> {
  const citations = observations.filter(
    (entry): entry is ObservationInput<"evidence_cited"> =>
      entry.eventType === "evidence_cited" && Boolean(entry.sourceId),
  );
  if (citations.length === 0) return;

  const chunkIds = [...new Set(citations.map((entry) => entry.sourceId as string))];

  try {
    const { data, error } = await supabase
      .from("concept_mentions")
      .select("chunk_id, concept_id, concepts!inner(canonical_key)")
      .in("chunk_id", chunkIds);

    if (error) {
      console.error("[concepts] citation attribution failed:", error.message);
      return;
    }

    const byChunk = new Map<string, { ids: Set<string>; keys: Set<string> }>();
    for (const row of data ?? []) {
      const chunkId = row.chunk_id as string;
      const entry = byChunk.get(chunkId) ?? { ids: new Set(), keys: new Set() };
      entry.ids.add(row.concept_id as string);

      const embedded = row.concepts as
        | { canonical_key?: string }
        | Array<{ canonical_key?: string }>
        | null;
      const concept = Array.isArray(embedded) ? embedded[0] : embedded;
      if (concept?.canonical_key) entry.keys.add(concept.canonical_key);

      byChunk.set(chunkId, entry);
    }

    for (const citation of citations) {
      const entry = byChunk.get(citation.sourceId as string);
      citation.payload.conceptIds = [...(entry?.ids ?? [])].slice(0, MAX_ATTRIBUTED_CONCEPTS);
      citation.payload.conceptKeys = [...(entry?.keys ?? [])].slice(0, MAX_ATTRIBUTED_CONCEPTS);
    }
  } catch (error) {
    console.error("[concepts] citation attribution threw:", error);
  }
}
