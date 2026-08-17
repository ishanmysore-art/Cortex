import { describe, expect, it } from "vitest";
import { chunkTextWithMetadata } from "../lib/documents/chunker";

describe("chunkTextWithMetadata", () => {
  it("creates ordered chunks with source and page metadata", () => {
    const firstPage = "One. ".repeat(180);
    const secondPage = "Two. ".repeat(180);
    const text = `${firstPage}\n\n${secondPage}`;
    const chunks = chunkTextWithMetadata(text, {
      maxTokens: 80,
      overlapTokens: 12,
      pages: [
        { page: 1, charStart: 0, charEnd: firstPage.length },
        { page: 2, charStart: firstPage.length + 2, charEnd: text.length },
      ],
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, charStart: 0, pageStart: 1 });
    expect(chunks.at(-1)).toMatchObject({ pageEnd: 2 });
    expect(chunks.every((chunk, index) => chunk.chunkIndex === index && chunk.tokenCount > 0)).toBe(true);
  });
});
