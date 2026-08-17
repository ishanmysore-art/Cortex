import { describe, expect, it } from "vitest";
import {
  isUuid,
  MAX_ASK_QUESTION_CHARS,
  validateTextInput,
  validateUpload,
} from "../lib/validation";

describe("input validation", () => {
  it("accepts supported, bounded uploads", () => {
    const result = validateUpload({
      name: "notes.md",
      type: "text/markdown",
      size: 512,
    } as File);

    expect(result).toEqual({
      fileType: "markdown",
      mimeType: "text/markdown",
      title: "notes.md",
    });
  });

  it("rejects unsupported and oversized uploads", () => {
    expect(validateUpload({ name: "payload.exe", type: "application/octet-stream", size: 20 } as File)).toHaveProperty("error");
    expect(validateUpload({ name: "huge.pdf", type: "application/pdf", size: 11 * 1024 * 1024 } as File)).toHaveProperty("error");
  });

  it("bounds question text and validates UUIDs", () => {
    expect(validateTextInput("  a grounded question  ", 100, "Question")).toBe("a grounded question");
    expect(validateTextInput("x".repeat(MAX_ASK_QUESTION_CHARS + 1), MAX_ASK_QUESTION_CHARS, "Question")).toHaveProperty("error");
    expect(isUuid("d2719d1f-b879-42ef-9e02-16622734ebc4")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
