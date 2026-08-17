import { AskChat } from "@/components/app/ask-chat";
import { MemoryPanel } from "@/components/app/memory-panel";
import { createClient } from "@/lib/supabase/server";

type AskPageProps = {
  searchParams: Promise<{ conversation?: string }>;
};

export default async function AskPage({ searchParams }: AskPageProps) {
  const { conversation: requestedConversationId } = await searchParams;
  const supabase = await createClient();
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, title")
    .order("updated_at", { ascending: false })
    .limit(30);
  const selectedConversationId = (conversations ?? []).some((conversation: { id: string }) => conversation.id === requestedConversationId)
    ? requestedConversationId!
    : (conversations?.[0] as { id: string } | undefined)?.id ?? null;

  const [messagesResult, memoriesResult] = await Promise.all([
    selectedConversationId
      ? supabase
          .from("messages")
          .select("id, role, content, status")
          .eq("conversation_id", selectedConversationId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as Array<{ id: string; role: "user" | "assistant"; content: string; status: "streaming" | "completed" | "failed" }> }),
    supabase
      .from("memories")
      .select("id, content")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  const messageIds = (messagesResult.data ?? []).map((message: { id: string }) => message.id);
  const { data: citationRows } = messageIds.length
    ? await supabase
        .from("message_citations")
        .select("message_id, citation_index, document_title_snapshot, excerpt_snapshot, page_start, page_end")
        .in("message_id", messageIds)
        .order("citation_index", { ascending: true })
    : { data: [] };

  const citationsByMessage = new Map<string, Array<{
    citationIndex: number;
    documentTitle: string;
    excerpt: string;
    pageStart: number | null;
    pageEnd: number | null;
  }>>();
  for (const citation of citationRows ?? []) {
    const row = citation as {
      message_id: string;
      citation_index: number;
      document_title_snapshot: string;
      excerpt_snapshot: string;
      page_start: number | null;
      page_end: number | null;
    };
    const entries = citationsByMessage.get(row.message_id) ?? [];
    entries.push({
      citationIndex: row.citation_index,
      documentTitle: row.document_title_snapshot,
      excerpt: row.excerpt_snapshot,
      pageStart: row.page_start,
      pageEnd: row.page_end,
    });
    citationsByMessage.set(row.message_id, entries);
  }

  const initialMessages = (messagesResult.data ?? []).map((message: {
    id: string;
    role: "user" | "assistant";
    content: string;
    status: "streaming" | "completed" | "failed";
  }) => ({ ...message, citations: citationsByMessage.get(message.id) ?? [] }));

  return (
    <>
      <header className="border-b border-border/60 px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Ask</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Ask questions grounded in your ready notes.</p>
      </header>
      <div className="grid xl:grid-cols-[minmax(0,1fr)_18rem]">
        <AskChat
          initialConversationId={selectedConversationId}
          initialMessages={initialMessages}
          conversations={(conversations ?? []) as Array<{ id: string; title: string }>}
        />
        <div className="border-t border-border/60 p-6 xl:border-l xl:border-t-0">
          <MemoryPanel memories={(memoriesResult.data ?? []) as Array<{ id: string; content: string }>} />
        </div>
      </div>
    </>
  );
}
