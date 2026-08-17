import { extractText, getDocumentProxy } from "unpdf";

export type SourcePage = {
  page: number;
  charStart: number;
  charEnd: number;
};

export type ExtractedDocument = {
  text: string;
  pages: SourcePage[];
};

export async function extractTextFromFile(file: File): Promise<string> {
  return (await extractDocumentFromFile(file)).text;
}

export async function extractDocumentFromFile(file: File): Promise<ExtractedDocument> {
  const fileType = file.type;
  const fileName = file.name.toLowerCase();

  if (fileType === "application/pdf" || fileName.endsWith(".pdf")) {
    return extractDocumentFromPDF(file);
  } else if (
    fileType === "text/plain" ||
    fileType === "text/markdown" ||
    fileName.endsWith(".md") ||
    fileName.endsWith(".txt")
  ) {
    const text = await file.text();
    return {
      text,
      pages: [{ page: 1, charStart: 0, charEnd: text.length }],
    };
  }

  throw new Error(`Unsupported file type: ${fileType || fileName}`);
}

async function extractDocumentFromPDF(file: File): Promise<ExtractedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  const { text: pages } = await extractText(pdf);
  const sourcePages: SourcePage[] = [];
  let offset = 0;

  const text = pages
    .map((pageText, index) => {
      const charStart = offset;
      offset += pageText.length;
      sourcePages.push({ page: index + 1, charStart, charEnd: offset });
      offset += 2;
      return pageText;
    })
    .join("\n\n");

  return { text, pages: sourcePages };
}
