export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
export const MAX_SEARCH_QUERY_CHARS = 1_000;
export const MAX_ASK_QUESTION_CHARS = 6_000;
export const MAX_MEMORY_CHARS = 1_000;

const supportedExtensions = new Set(["pdf", "md", "txt"]);
const supportedMimeTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "",
]);

export type ValidatedUpload = {
  fileType: "pdf" | "markdown" | "text";
  mimeType: string | null;
  title: string;
};

export function validateUpload(file: File): ValidatedUpload | { error: string } {
  const title = file.name.replace(/[\u0000-\u001f]/g, "").trim();
  const extension = title.split(".").pop()?.toLowerCase() ?? "";

  if (!title || title.length > 255) {
    return { error: "File name must be between 1 and 255 characters." };
  }
  if (!supportedExtensions.has(extension) || !supportedMimeTypes.has(file.type)) {
    return { error: "Only PDF, Markdown, and plain-text files are supported." };
  }
  if (file.size <= 0) {
    return { error: "The selected file is empty." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "Files must be 10 MB or smaller." };
  }

  const fileType = extension === "pdf" ? "pdf" : extension === "md" ? "markdown" : "text";
  return { fileType, mimeType: file.type || null, title };
}

export function validateTextInput(
  value: unknown,
  maxLength: number,
  label: string,
): string | { error: string } {
  if (typeof value !== "string") {
    return { error: `${label} is required.` };
  }

  const text = value.trim();
  if (!text) {
    return { error: `${label} is required.` };
  }
  if (text.length > maxLength) {
    return { error: `${label} must be ${maxLength.toLocaleString()} characters or fewer.` };
  }
  return text;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
