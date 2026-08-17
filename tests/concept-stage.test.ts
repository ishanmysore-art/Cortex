/**
 * The concept stage is deliberately non-fatal.
 *
 * Search and Ask depend on chunks and embeddings, not on the concept graph, so
 * a failure here must never keep a document out of the knowledge base. These
 * tests pin that contract.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runConceptStage } from "../lib/ingestion/processor";

type Recorded = { table: string; rows: Array<Record<string, unknown>> };

/**
 * A Supabase double covering only what the concept stage touches:
 * the chunk read it starts from and the observation write it ends with.
 */
function mockSupabase({ chunkError }: { chunkError?: string } = {}) {
  const recorded: Recorded[] = [];

  const client = {
    from(table: string) {
      if (table === "observations") {
        return {
          upsert(rows: Array<Record<string, unknown>>) {
            recorded.push({ table, rows });
            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "document_chunks") {
        const result = chunkError
          ? { data: null, error: { message: chunkError } }
          : { data: [], error: null };
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => Promise.resolve(result),
        };
        return builder;
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, recorded };
}

const STAGE_ARGS = {
  userId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  documentTitle: "paper.pdf",
  jobId: "33333333-3333-4333-8333-333333333333",
};

describe("runConceptStage", () => {
  it("swallows a failure instead of breaking the ingestion", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, recorded } = mockSupabase({ chunkError: "connection reset" });

    // The assertion is the absence of a throw: the caller marks the document
    // ready immediately after this returns.
    await expect(runConceptStage(client, STAGE_ARGS)).resolves.toBeUndefined();

    const observations = recorded.flatMap((entry) => entry.rows);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      event_type: "concept_extraction_failed",
      event_category: "document",
      actor: "system",
      source_type: "document",
      source_id: STAGE_ARGS.documentId,
      user_id: STAGE_ARGS.userId,
    });

    consoleError.mockRestore();
  });

  it("records why extraction failed, in bounded form", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, recorded } = mockSupabase({ chunkError: "connection reset" });

    await runConceptStage(client, STAGE_ARGS);

    const payload = recorded[0].rows[0].payload as { title: string; reason: string };
    expect(payload.title).toBe("paper.pdf");
    expect(payload.reason).toContain("connection reset");
    expect(payload.reason.length).toBeLessThanOrEqual(500);

    consoleError.mockRestore();
  });

  it("does nothing when a document produced no chunks", async () => {
    const { client, recorded } = mockSupabase();
    await expect(runConceptStage(client, STAGE_ARGS)).resolves.toBeUndefined();
    // No chunks means nothing to ground a concept in, which is not a failure.
    expect(recorded).toHaveLength(0);
  });
});
