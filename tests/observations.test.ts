import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OBSERVATION_ACTORS,
  OBSERVATION_CATEGORIES,
  OBSERVATION_EVENTS,
  OBSERVATION_EVENT_TYPES,
  OBSERVATION_SOURCE_TYPES,
  buildObservationRow,
  isObservationEventType,
  recordObservation,
  recordObservations,
  type ObservationInput,
} from "../lib/observations";

type UpsertCall = { table: string; rows: unknown[]; options: unknown };

function mockSupabase(result: { error: { message: string } | null } = { error: null }) {
  const calls: UpsertCall[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(rows: unknown[], options: unknown) {
          calls.push({ table, rows, options });
          return Promise.resolve(result);
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function throwingSupabase() {
  return {
    from() {
      throw new Error("connection reset");
    },
  } as unknown as SupabaseClient;
}

const USER = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";

describe("observation taxonomy", () => {
  it("keeps every event definition internally consistent", () => {
    for (const eventType of OBSERVATION_EVENT_TYPES) {
      const definition = OBSERVATION_EVENTS[eventType];
      expect(OBSERVATION_CATEGORIES).toContain(definition.category);
      expect(OBSERVATION_ACTORS).toContain(definition.actor);
      expect(OBSERVATION_SOURCE_TYPES).toContain(definition.sourceType);
      expect(definition.describes.length).toBeGreaterThan(0);
      // The database CHECKs bound these; a new event type must not exceed them.
      expect(eventType.length).toBeLessThanOrEqual(64);
      expect(definition.category.length).toBeLessThanOrEqual(32);
      expect(definition.sourceType.length).toBeLessThanOrEqual(32);
    }
  });

  it("recognises only known event types", () => {
    expect(isObservationEventType("question_asked")).toBe(true);
    expect(isObservationEventType("user_is_a_visual_learner")).toBe(false);
    expect(isObservationEventType(42)).toBe(false);
  });

  it("records no event that asserts a conclusion about the user", () => {
    // Guards the observation/inference boundary against future additions.
    const inferenceWords = /(believe|prefers?|learner|style|trait|personality|knows|understands)/i;
    for (const eventType of OBSERVATION_EVENT_TYPES) {
      expect(eventType).not.toMatch(inferenceWords);
    }
  });
});

describe("buildObservationRow", () => {
  it("derives category, actor, and source type from the taxonomy", () => {
    const row = buildObservationRow({
      userId: USER,
      eventType: "question_asked",
      sourceId: MESSAGE,
      context: { conversationId: "conv-1", messageId: MESSAGE },
      payload: { characterCount: 12, isFollowUp: false },
      dedupeKey: `question_asked:${MESSAGE}`,
    });

    expect(row).toMatchObject({
      user_id: USER,
      event_type: "question_asked",
      event_category: "interaction",
      actor: "user",
      source_type: "message",
      source_id: MESSAGE,
      dedupe_key: `question_asked:${MESSAGE}`,
    });
    expect(new Date(row.occurred_at).toString()).not.toBe("Invalid Date");
  });

  it("honours an explicit occurredAt so a late write keeps the real time", () => {
    const occurredAt = new Date("2026-03-04T05:06:07.000Z");
    const row = buildObservationRow({
      userId: USER,
      eventType: "search_performed",
      occurredAt,
      payload: { query: "sleep", resultCount: 3, topSimilarity: 0.8 },
    });
    expect(row.occurred_at).toBe(occurredAt.toISOString());
  });

  it("requires a source id for events that point at a row", () => {
    expect(() =>
      buildObservationRow({
        userId: USER,
        eventType: "document_uploaded",
        payload: { title: "a.pdf", fileType: "pdf", fileSizeBytes: 10 },
      }),
    ).toThrow(/requires a document source id/);
  });

  it("allows a missing source id only for system-sourced events", () => {
    const row = buildObservationRow({
      userId: USER,
      eventType: "search_performed",
      payload: { query: "sleep", resultCount: 0, topSimilarity: null },
    });
    expect(row.source_type).toBe("system");
    expect(row.source_id).toBeNull();
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      buildObservationRow({
        userId: USER,
        eventType: "user_forgot_everything",
        payload: {},
      } as unknown as ObservationInput),
    ).toThrow(/Unknown observation event type/);
  });

  it("rejects a missing user id", () => {
    expect(() =>
      buildObservationRow({
        userId: "",
        eventType: "search_performed",
        payload: { query: "x", resultCount: 0, topSimilarity: null },
      }),
    ).toThrow(/missing a user id/);
  });

  it("rejects a payload large enough to be content rather than metadata", () => {
    expect(() =>
      buildObservationRow({
        userId: USER,
        eventType: "search_performed",
        payload: { query: "x".repeat(9_000), resultCount: 0, topSimilarity: null },
      }),
    ).toThrow(/Reference the source row instead of copying its content/);
  });
});

describe("recordObservations", () => {
  it("writes to observations with duplicate suppression on the dedupe key", async () => {
    const { client, calls } = mockSupabase();
    const result = await recordObservation(client, {
      userId: USER,
      eventType: "memory_stated",
      sourceId: MESSAGE,
      payload: { characterCount: 4 },
      dedupeKey: `memory_stated:${MESSAGE}`,
    });

    expect(result).toEqual({ attempted: 1, ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("observations");
    expect(calls[0].options).toEqual({
      onConflict: "user_id,dedupe_key",
      ignoreDuplicates: true,
    });
  });

  it("sends a batch as one round trip", async () => {
    const { client, calls } = mockSupabase();
    const result = await recordObservations(client, [
      {
        userId: USER,
        eventType: "answer_generated",
        sourceId: MESSAGE,
        payload: {
          model: "gpt-4o-mini",
          promptVersion: "ask-v2.5-trace",
          citationCount: 2,
          retrievedSourceCount: 8,
          grounded: true,
          latencyMs: 900,
        },
      },
      {
        userId: USER,
        eventType: "evidence_cited",
        sourceId: MESSAGE,
        payload: {
          citationIndex: 1,
          documentId: null,
          documentTitle: "paper.pdf",
          pageStart: 3,
          pageEnd: 3,
          similarity: 0.71,
          conceptIds: [],
          conceptKeys: [],
        },
      },
    ]);

    expect(result).toEqual({ attempted: 2, ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].rows).toHaveLength(2);
  });

  it("is a no-op for an empty batch", async () => {
    const { client, calls } = mockSupabase();
    expect(await recordObservations(client, [])).toEqual({ attempted: 0, ok: true });
    expect(calls).toHaveLength(0);
  });

  it("never throws when the database rejects the write", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = mockSupabase({ error: { message: "permission denied" } });

    const result = await recordObservation(client, {
      userId: USER,
      eventType: "memory_archived",
      sourceId: MESSAGE,
      payload: {},
    });

    expect(result).toMatchObject({ ok: false, error: "permission denied" });
    consoleError.mockRestore();
  });

  it("never throws when the client itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await recordObservation(throwingSupabase(), {
      userId: USER,
      eventType: "memory_archived",
      sourceId: MESSAGE,
      payload: {},
    });
    expect(result).toMatchObject({ ok: false, error: "connection reset" });
    consoleError.mockRestore();
  });

  it("never throws when an input is invalid, and writes nothing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls } = mockSupabase();

    const result = await recordObservations(client, [
      {
        userId: USER,
        eventType: "document_uploaded",
        payload: { title: "a.pdf", fileType: "pdf", fileSizeBytes: 1 },
      },
    ]);

    expect(result.ok).toBe(false);
    // One bad row must not silently drop the rest of the batch either.
    expect(calls).toHaveLength(0);
    consoleError.mockRestore();
  });
});
