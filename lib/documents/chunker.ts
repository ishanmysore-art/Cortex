import { getEncoding } from "js-tiktoken";
import type { SourcePage } from "@/lib/documents/parsers";

export function chunkText(text: string, maxTokens: number = 800): string[] {
  return chunkTextWithMetadata(text, { maxTokens }).map((chunk) => chunk.content);
}

export type DocumentChunk = {
  content: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  pageStart: number | null;
  pageEnd: number | null;
};

type ChunkingOptions = {
  maxTokens?: number;
  overlapTokens?: number;
  pages?: SourcePage[];
};

type Segment = { content: string; start: number; end: number };

/**
 * Preserves source offsets for citations while retaining a modest token overlap
 * between chunks. Chunks are derived from paragraph/sentence boundaries first,
 * then token-sliced only when a single unit is too large.
 */
export function chunkTextWithMetadata(
  text: string,
  { maxTokens = 700, overlapTokens = 100, pages = [] }: ChunkingOptions = {},
): DocumentChunk[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const enc = getEncoding("cl100k_base");
  const chunks: DocumentChunk[] = [];

  try {
    const segments = splitSegments(normalized, enc, maxTokens);
    let current: Segment[] = [];
    let currentTokens = 0;
    let carry = "";

    const commit = () => {
      if (current.length === 0) return;
      const sourceContent = current.map((segment) => segment.content).join("\n\n").trim();
      const content = carry ? `${carry}\n\n${sourceContent}` : sourceContent;
      const start = current[0].start;
      const end = current[current.length - 1].end;
      const pageRange = getPageRange(start, end, pages);
      chunks.push({
        content,
        chunkIndex: chunks.length,
        charStart: start,
        charEnd: end,
        tokenCount: enc.encode(content).length,
        pageStart: pageRange?.start ?? null,
        pageEnd: pageRange?.end ?? null,
      });
      const sourceTokens = enc.encode(sourceContent);
      carry = enc.decode(sourceTokens.slice(Math.max(0, sourceTokens.length - overlapTokens))).trim();
      current = [];
      currentTokens = 0;
    };

    for (const segment of segments) {
      const tokenCount = enc.encode(segment.content).length;
      if (currentTokens > 0 && currentTokens + tokenCount > maxTokens) {
        commit();
      }
      current.push(segment);
      currentTokens += tokenCount;
    }
    commit();
  } finally {
    // js-tiktoken's public type does not expose an explicit disposer.
  }

  return chunks.filter((chunk) => chunk.content.length > 0);
}

function splitSegments(text: string, enc: ReturnType<typeof getEncoding>, maxTokens: number): Segment[] {
  const paragraphs = [...text.matchAll(/[^\n]+(?:\n+|$)/g)]
    .map((match) => ({ content: match[0].trim(), start: match.index ?? 0 }))
    .filter((segment) => segment.content.length > 0)
    .map((segment) => ({ ...segment, end: segment.start + segment.content.length }));

  return paragraphs.flatMap((paragraph) => splitOversizedSegment(paragraph, enc, maxTokens));
}

function splitOversizedSegment(segment: Segment, enc: ReturnType<typeof getEncoding>, maxTokens: number): Segment[] {
  if (enc.encode(segment.content).length <= maxTokens) return [segment];

  const sentenceMatches = [...segment.content.matchAll(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)];
  const sentences = sentenceMatches.length > 0
    ? sentenceMatches.map((match) => ({
        content: match[0].trim(),
        start: segment.start + (match.index ?? 0),
        end: segment.start + (match.index ?? 0) + match[0].trim().length,
      }))
    : [segment];

  return sentences.flatMap((sentence) => {
    const tokens = enc.encode(sentence.content);
    if (tokens.length <= maxTokens) return [sentence];

    const pieces: Segment[] = [];
    let searchFrom = 0;
    for (let index = 0; index < tokens.length; index += maxTokens) {
      const content = enc.decode(tokens.slice(index, index + maxTokens)).trim();
      const relativeStart = Math.max(searchFrom, sentence.content.indexOf(content, searchFrom));
      pieces.push({
        content,
        start: sentence.start + relativeStart,
        end: sentence.start + relativeStart + content.length,
      });
      searchFrom = relativeStart + content.length;
    }
    return pieces;
  });
}

function getPageRange(start: number, end: number, pages: SourcePage[]) {
  const matched = pages.filter((page) => page.charEnd >= start && page.charStart <= end);
  if (matched.length === 0) return null;
  return { start: matched[0].page, end: matched[matched.length - 1].page };
}
