/** Shared types will live here as the app grows. */

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export type Document = {
  id: string;
  title: string;
  fileType: "markdown" | "pdf" | "text";
  status: DocumentStatus;
  createdAt: string;
};

export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "streaming" | "completed" | "failed";

export type Citation = {
  citationIndex: number;
  documentTitle: string;
  excerpt: string;
  pageStart: number | null;
  pageEnd: number | null;
};

export type ConversationMessage = {
  id: string;
  role: ConversationMessageRole;
  content: string;
  status: ConversationMessageStatus;
  citations: Citation[];
};
