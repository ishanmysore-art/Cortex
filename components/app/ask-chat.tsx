"use client";

import { FormEvent, KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

type Citation = {
  citationIndex: number;
  documentTitle: string;
  excerpt: string;
  pageStart: number | null;
  pageEnd: number | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "completed" | "failed";
  citations: Citation[];
};

type Conversation = { id: string; title: string };

type AskChatProps = {
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  conversations: Conversation[];
};

export function AskChat({ initialConversationId, initialMessages, conversations }: AskChatProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState(initialMessages);
  const [conversationList, setConversationList] = useState(conversations);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function newConversation() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    router.push("/dashboard/ask");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || isStreaming) return;

    const temporaryUserId = `user-${crypto.randomUUID()}`;
    const temporaryAssistantId = `assistant-${crypto.randomUUID()}`;
    setError(null);
    setIsStreaming(true);
    setMessages((current) => [
      ...current,
      { id: temporaryUserId, role: "user", content: question, status: "completed", citations: [] },
      { id: temporaryAssistantId, role: "assistant", content: "", status: "streaming", citations: [] },
    ]);
    setDraft("");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Unable to start an answer.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          if (!event.startsWith("data: ")) continue;
          const payload = JSON.parse(event.slice(6)) as {
            type: string;
            text?: string;
            error?: string;
            conversationId?: string;
            userMessageId?: string;
            assistantMessageId?: string;
            citations?: Citation[];
          };

          if (payload.type === "meta" && payload.conversationId && payload.userMessageId && payload.assistantMessageId) {
            setConversationId(payload.conversationId);
            setMessages((current) => current.map((message) => {
              if (message.id === temporaryUserId) return { ...message, id: payload.userMessageId! };
              if (message.id === temporaryAssistantId) return { ...message, id: payload.assistantMessageId! };
              return message;
            }));
            setConversationList((current) => current.some((item) => item.id === payload.conversationId)
              ? current
              : [{ id: payload.conversationId!, title: question.slice(0, 80) }, ...current]);
          }

          if (payload.type === "delta" && payload.text) {
            setMessages((current) => current.map((message) =>
              message.id === temporaryAssistantId || message.status === "streaming"
                ? { ...message, content: `${message.content}${payload.text}` }
                : message,
            ));
          }

          if (payload.type === "done") {
            setMessages((current) => current.map((message) =>
              message.id === temporaryAssistantId || message.status === "streaming"
                ? { ...message, status: "completed", citations: payload.citations ?? [] }
                : message,
            ));
          }

          if (payload.type === "error") {
            setError(payload.error ?? "The answer could not be completed.");
            setMessages((current) => current.map((message) =>
              message.id === temporaryAssistantId || message.status === "streaming"
                ? { ...message, status: "failed" }
                : message,
            ));
          }
        }
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "The answer could not be completed.");
      setMessages((current) => current.map((message) =>
        message.id === temporaryAssistantId ? { ...message, status: "failed" } : message,
      ));
    } finally {
      setIsStreaming(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!isStreaming && draft.trim()) formRef.current?.requestSubmit();
    }
  }

  return (
    <section className="grid min-h-[calc(100vh-89px)] grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="border-b border-border/60 p-3 sm:p-4 lg:border-b-0 lg:border-r">
        <Button type="button" variant="secondary" size="sm" onClick={newConversation} className="w-full justify-start gap-2">
          <Plus className="h-4 w-4" /> New conversation
        </Button>
        {conversationList.length > 0 && (
          <nav className="mt-3 flex max-h-32 flex-col overflow-y-auto space-y-1 lg:max-h-none" aria-label="Conversations">
            {conversationList.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => router.push(`/dashboard/ask?conversation=${conversation.id}`)}
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs ${conversation.id === conversationId ? "bg-surface font-medium text-foreground" : "text-muted-foreground hover:bg-surface"}`}
                title={conversation.title}
              >
                {conversation.title}
              </button>
            ))}
          </nav>
        )}
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="flex-1 space-y-6 p-3 sm:p-6" aria-live="off">
          {messages.length === 0 ? (
            <div className="mx-auto mt-12 sm:mt-16 max-w-lg text-center">
              <h2 className="text-lg font-semibold">Ask your notes</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Answers are grounded in your ready documents. Add memories explicitly when you want them carried into future chats.
              </p>
            </div>
          ) : messages.map((message) => <MessageBubble key={message.id} message={message} />)}
        </div>

        <form ref={formRef} onSubmit={submit} className="border-t border-border/60 bg-background p-3 sm:p-4">
          <div className="mx-auto flex max-w-3xl gap-2">
            <label className="sr-only" htmlFor="ask-input">Ask your notes</label>
            <textarea
              ref={inputRef}
              id="ask-input"
              rows={2}
              maxLength={6000}
              disabled={isStreaming}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask a question about your notes…"
              aria-describedby="ask-keyboard-hint"
              className="min-h-11 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-foreground disabled:opacity-50"
            />
            <Button type="submit" disabled={isStreaming || !draft.trim()} aria-label="Send question" className="self-end">
              {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p id="ask-keyboard-hint" className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">
            Press Enter to send. Use Shift+Enter for a new line.
          </p>
          {error && <p role="alert" className="mx-auto mt-2 max-w-3xl text-sm text-red-600">{error}</p>}
          <p className="sr-only" aria-live="polite">{isStreaming ? "Generating answer" : ""}</p>
        </form>
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`mx-auto max-w-3xl ${message.role === "user" ? "pl-4 sm:pl-12" : "pr-4 sm:pr-12"}`}>
      <p className="mb-1 text-xs font-medium capitalize text-muted-foreground">{message.role}</p>
      <div className={`whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-relaxed ${message.role === "user" ? "bg-surface" : "border border-border bg-card"}`}>
        {message.content || (message.status === "streaming" ? "Thinking…" : "No answer was generated.")}
      </div>
      {message.status === "failed" && <p className="mt-2 text-xs text-red-600">This response was interrupted. You can retry your question.</p>}
      {message.citations.length > 0 && (
        <details className="mt-3 rounded-lg border border-border/70 bg-surface/40 p-3 text-xs" open>
          <summary className="cursor-pointer font-medium">Sources</summary>
          <ol className="mt-2 space-y-3">
            {message.citations.map((citation) => (
              <li key={citation.citationIndex} className="leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">[{citation.citationIndex}] {citation.documentTitle}</span>
                {citation.pageStart && <span> · page {citation.pageStart}{citation.pageEnd && citation.pageEnd !== citation.pageStart ? `–${citation.pageEnd}` : ""}</span>}
                <p className="mt-1 whitespace-pre-wrap">{citation.excerpt}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
