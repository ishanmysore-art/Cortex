import { createHash } from "crypto";
import { NextResponse, after } from "next/server";
import { refreshInferences, syncMessageClaims } from "@/lib/claims";
import { attachConceptAttribution } from "@/lib/concepts";
import { refreshKnowledgeStates } from "@/lib/knowledge";
import { refreshNotices } from "@/lib/notices";
import openai from "@/lib/openai/client";
import { recordAiUsage } from "@/lib/observability";
import { recordObservations, type ObservationInput } from "@/lib/observations";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  ASK_INSTRUCTIONS,
  ASK_PROMPT_VERSION,
  GROUNDING_VERIFIER_INSTRUCTIONS,
  buildAskInput,
  buildPromptCacheKey,
  buildVerificationInput,
  citedSources,
  isComprehensiveDatasetQuery,
  isEvidenceAuditQuestion,
  mergeEvidenceSources,
  retrieveRelevantChunks,
  validateGroundedAnswer,
  type PromptMessage,
} from "@/lib/rag/retrieval";
import { createClient } from "@/lib/supabase/server";
import { isUuid, MAX_ASK_QUESTION_CHARS, validateTextInput } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AskRequest = { question?: unknown; conversationId?: unknown };

export async function POST(request: Request) {
  let body: AskRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const question = validateTextInput(body.question, MAX_ASK_QUESTION_CHARS, "Question");
  if (typeof question !== "string") {
    return NextResponse.json(question, { status: 400 });
  }
  if (body.conversationId !== undefined && body.conversationId !== null && !isUuid(body.conversationId)) {
    return NextResponse.json({ error: "Conversation ID is invalid." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  console.info("[ASK] request authenticated");
  if (!(await consumeRateLimit(supabase, "ask"))) {
    return NextResponse.json({ error: "Ask limit reached. Please wait a minute and try again." }, { status: 429 });
  }

  const conversation = await resolveConversation(supabase, user.id, body.conversationId, question);
  if ("error" in conversation) {
    return NextResponse.json(conversation, { status: 404 });
  }

  const { data: userMessage, error: userMessageError } = await supabase
    .from("messages")
    .insert({ conversation_id: conversation.id, role: "user", content: question })
    .select("id")
    .single();
  if (userMessageError || !userMessage) {
    console.error("Failed to persist user message", userMessageError);
    return NextResponse.json({ error: "Unable to save your message." }, { status: 500 });
  }

  // Observations are collected as the request proceeds and flushed once, after
  // the response, so recording history never adds latency to the answer. The
  // question text is deliberately not copied: it lives in `messages` and is
  // reachable through `source_id`.
  const askedAt = new Date();
  const isFollowUp = typeof body.conversationId === "string";
  const observations: ObservationInput[] = [];
  const questionObservation: ObservationInput = {
    userId: user.id,
    eventType: "question_asked",
    sourceId: userMessage.id,
    occurredAt: askedAt,
    context: { conversationId: conversation.id, messageId: userMessage.id },
    payload: { characterCount: question.length, isFollowUp },
    dedupeKey: `question_asked:${userMessage.id}`,
  };
  const flushObservations = () => {
    const pending = observations.splice(0, observations.length);
    if (pending.length === 0) return;
    // Recording and the projection refresh share one callback so their order is
    // guaranteed: separate `after` callbacks have no defined ordering, and a
    // refresh that ran first would miss the citations it is meant to count.
    const citedEvidence = pending.some((entry) => entry.eventType === "evidence_cited");
    after(async () => {
      // Stamp citations with the concepts they carried while the mentions still
      // exist, so the attribution survives the document being deleted later.
      if (citedEvidence) await attachConceptAttribution(supabase, pending);
      await recordObservations(supabase, pending);
      // Only when this answer cited something; nothing else moves the counts.
      if (citedEvidence) await refreshKnowledgeStates(supabase);
    });
  };

  // Explicit-claim extraction runs after the response, so it adds no latency to
  // the answer, and never fails the request: a missed claim is recoverable by
  // restating it, a broken Ask is not.
  after(async () => {
    try {
      const result = await syncMessageClaims(supabase, {
        userId: user.id,
        messageId: userMessage.id,
        content: question,
      });
      // Only when this message actually contributed a claim; inference reads
      // claims, so nothing else can move it. Not surfaced anywhere — M5 is the
      // data model, not a proactive agent.
      if (result.claimsCreated > 0 || result.claimsReinforced > 0) {
        await refreshInferences(supabase);
        await refreshNotices(supabase);
      }
    } catch (error) {
      console.error("[ASK] claim extraction failed", error);
    }
  });

  let historyRows: Array<PromptMessage> = [];
  let memoryRows: Array<{ content: string }> = [];
  let priorEvidenceRows: Array<{
    message_id: string;
    citation_index: number;
    document_id: string | null;
    chunk_id: string | null;
    document_title_snapshot: string;
    excerpt_snapshot: string;
    page_start: number | null;
    page_end: number | null;
  }> = [];
  let retrieval: Awaited<ReturnType<typeof retrieveRelevantChunks>>;
  try {
    console.info("[ASK] retrieval started");
    const [historyResult, memoryResult, retrievalResult] = await Promise.all([
      supabase
        .from("messages")
        .select("id, role, content")
        .eq("conversation_id", conversation.id)
        .neq("id", userMessage.id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("memories")
        .select("content")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(8),
      retrieveRelevantChunks(supabase, question, isComprehensiveDatasetQuery(question) ? 30 : 20),
    ]);
    historyRows = (historyResult.data ?? []) as PromptMessage[];
    memoryRows = (memoryResult.data ?? []) as Array<{ content: string }>;
    retrieval = retrievalResult;
    if (isEvidenceAuditQuestion(question)) {
      const assistantMessageIds = (historyResult.data ?? [])
        .filter((message: { role?: string }) => message.role === "assistant")
        .map((message: { id: string }) => message.id);
      if (assistantMessageIds.length > 0) {
        const { data: priorCitationData, error: priorCitationError } = await supabase
          .from("message_citations")
          .select("message_id, citation_index, document_id, chunk_id, document_title_snapshot, excerpt_snapshot, page_start, page_end")
          .in("message_id", assistantMessageIds)
          .order("citation_index", { ascending: true });
        if (priorCitationError) {
          console.error("Unable to load prior evidence trace", priorCitationError);
        } else {
          priorEvidenceRows = (priorCitationData ?? []) as typeof priorEvidenceRows;
        }
      }
    }
    console.info("[ASK] retrieval complete", { sourceCount: retrieval.sources.length });
  } catch (error) {
    console.error("[ASK ERROR] stage=retrieval", error);
    await persistFailedAssistantMessage(supabase, conversation.id, "I couldn't retrieve your notes for this question. Please try again.");
    observations.push(questionObservation, {
      userId: user.id,
      eventType: "answer_failed",
      sourceId: conversation.id,
      context: { conversationId: conversation.id, messageId: userMessage.id },
      payload: { stage: "retrieval", reason: toObservationReason(error) },
      dedupeKey: `answer_failed:${userMessage.id}`,
    });
    flushObservations();
    return NextResponse.json({ error: "Unable to retrieve relevant notes. Please try again." }, { status: 503 });
  }

  observations.push(questionObservation);

  const history = historyRows.reverse();
  const memories = memoryRows.map((memory) => memory.content);
  const priorEvidence = priorEvidenceRows.map((row) => ({
    id: row.chunk_id ?? `message-citation:${row.message_id}:${row.citation_index}`,
    document_id: row.document_id ?? "",
    chunk_index: -1,
    content: row.excerpt_snapshot,
    similarity: 1,
    document_title: row.document_title_snapshot,
    document_file_type: "",
    page_start: row.page_start,
    page_end: row.page_end,
  }));
  const evidenceSources = mergeEvidenceSources(retrieval.sources, priorEvidence);
  const promptInput = buildAskInput({
    history,
    memories,
    sources: evidenceSources,
    priorEvidence,
    question,
  });
  console.info("[ASK] prompt prepared", { promptLength: promptInput.length });

  const { data: assistantMessage, error: assistantMessageError } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: "",
      status: "streaming",
      model: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
      prompt_version: ASK_PROMPT_VERSION,
    })
    .select("id")
    .single();
  if (assistantMessageError || !assistantMessage) {
    console.error("Failed to persist assistant placeholder", assistantMessageError);
    return NextResponse.json({ error: "Unable to start an answer." }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
  let answer: string;
  let grounded = false;
  let citations: ReturnType<typeof citedSources>;
  let draftResponse: Awaited<ReturnType<typeof openai.responses.create>>;
  let verificationResponse: Awaited<ReturnType<typeof openai.responses.create>> | null = null;

  try {
    // Generate before returning the response. Keeping model work in the route
    // handler matches the original working lifecycle and avoids a server runtime
    // cancelling async work started from ReadableStream.start().
    console.info("[ASK] draft generation started");
    draftResponse = await openai.responses.create({
      model,
      instructions: ASK_INSTRUCTIONS,
      input: promptInput,
      max_output_tokens: 1_200,
      prompt_cache_key: buildPromptCacheKey("draft", conversation.id),
      safety_identifier: hashUserId(user.id),
      store: false,
    });
    const draft = draftResponse.output_text.trim();
    console.info("[ASK] draft generation complete", { outputLength: draft.length });
    let candidate = draft;
    try {
      console.info("[ASK] verification started");
      verificationResponse = await openai.responses.create({
        model,
        instructions: GROUNDING_VERIFIER_INSTRUCTIONS,
        input: buildVerificationInput({ draft, sources: evidenceSources, question }),
        max_output_tokens: 1_200,
        prompt_cache_key: buildPromptCacheKey("verify", conversation.id),
        safety_identifier: hashUserId(user.id),
        store: false,
      });
      candidate = verificationResponse.output_text.trim() || draft;
      console.info("[ASK] verification complete", { outputLength: candidate.length });
    } catch (verificationError) {
      console.error("[ASK ERROR] stage=verification; using draft", verificationError);
    }

    const candidateGrounding = validateGroundedAnswer(candidate, evidenceSources, question);
    const draftGrounding = candidate === draft
      ? candidateGrounding
      : validateGroundedAnswer(draft, evidenceSources, question);
    grounded = Boolean((candidate && candidateGrounding.valid) || (draft && draftGrounding.valid));
    answer = candidate && candidateGrounding.valid
      ? candidate
      : draft && draftGrounding.valid
        ? draft
        : "I couldn't find evidence for this in the documents you've provided.";
    citations = citedSources(answer, evidenceSources);
    console.info("[ASK] answer prepared", { answerLength: answer.length, citationCount: citations.length });
  } catch (error) {
    console.error("[ASK ERROR] stage=generation", error);
    await supabase
      .from("messages")
      .update({
        content: "I couldn't complete an evidence-grounded answer. Please try again.",
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", assistantMessage.id);
    observations.push({
      userId: user.id,
      eventType: "answer_failed",
      sourceId: conversation.id,
      context: { conversationId: conversation.id, messageId: assistantMessage.id },
      payload: { stage: "generation", reason: toObservationReason(error) },
      dedupeKey: `answer_failed:${assistantMessage.id}`,
    });
    flushObservations();
    return NextResponse.json({ error: "Unable to generate an answer. Please try again." }, { status: 503 });
  }

  const { error: completeError } = await supabase
    .from("messages")
    .update({ content: answer, status: "completed", completed_at: new Date().toISOString() })
    .eq("id", assistantMessage.id);
  if (completeError) console.error("Failed to persist completed answer", completeError);

  if (citations.length > 0) {
    const { error: citationError } = await supabase.from("message_citations").insert(
      citations.map(({ citationIndex, source }) => ({
        message_id: assistantMessage.id,
        citation_index: citationIndex,
        document_id: isUuid(source.document_id) ? source.document_id : null,
        chunk_id: isUuid(source.id) ? source.id : null,
        document_title_snapshot: source.document_title,
        excerpt_snapshot: source.content.slice(0, 2_400),
        page_start: source.page_start,
        page_end: source.page_end,
      })),
    );
    if (citationError) console.error("Failed to persist answer citations", citationError);
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversation.id);

  await recordAiUsage(supabase, {
    userId: user.id,
    operation: "ask",
    model,
    inputTokens: (draftResponse.usage?.input_tokens ?? 0) + (verificationResponse?.usage?.input_tokens ?? 0),
    outputTokens: (draftResponse.usage?.output_tokens ?? 0) + (verificationResponse?.usage?.output_tokens ?? 0),
    cachedTokens: (draftResponse.usage?.input_tokens_details?.cached_tokens ?? 0) + (verificationResponse?.usage?.input_tokens_details?.cached_tokens ?? 0),
    cacheWriteTokens: (draftResponse.usage?.input_tokens_details?.cache_write_tokens ?? 0) + (verificationResponse?.usage?.input_tokens_details?.cache_write_tokens ?? 0),
    latencyMs: Date.now() - startedAt,
  });

  observations.push({
    userId: user.id,
    eventType: "answer_generated",
    sourceId: assistantMessage.id,
    context: { conversationId: conversation.id, messageId: assistantMessage.id },
    payload: {
      model,
      promptVersion: ASK_PROMPT_VERSION,
      citationCount: citations.length,
      retrievedSourceCount: retrieval.sources.length,
      grounded,
      latencyMs: Date.now() - startedAt,
    },
    dedupeKey: `answer_generated:${assistantMessage.id}`,
  });

  // One observation per citation, pointing at the chunk that supported the
  // claim. Replayed prior-answer evidence carries a synthetic id and is skipped:
  // it was already observed when that answer was first produced.
  for (const { citationIndex, source } of citations) {
    if (!isUuid(source.id)) continue;
    observations.push({
      userId: user.id,
      eventType: "evidence_cited",
      sourceId: source.id,
      context: {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        documentId: isUuid(source.document_id) ? source.document_id : undefined,
        chunkId: source.id,
      },
      payload: {
        citationIndex,
        documentId: isUuid(source.document_id) ? source.document_id : null,
        documentTitle: source.document_title,
        pageStart: source.page_start,
        pageEnd: source.page_end,
        similarity: Number.isFinite(source.similarity) ? source.similarity : null,
        // Filled by `attachConceptAttribution` at flush time.
        conceptIds: [],
        conceptKeys: [],
      },
      dedupeKey: `evidence_cited:${assistantMessage.id}:${citationIndex}`,
    });
  }

  flushObservations();

  const responseStream = new ReadableStream({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      send({
        type: "meta",
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      });
      send({ type: "delta", text: answer });
      send({
        type: "done",
        assistantMessageId: assistantMessage.id,
        citations: citations.map(({ citationIndex, source }) => ({
          citationIndex,
          documentTitle: source.document_title,
          excerpt: source.content.slice(0, 1_000),
          pageStart: source.page_start,
          pageEnd: source.page_end,
        })),
      });
      console.info("[ASK] answer events emitted");
      controller.close();
    },
  });

  return new Response(responseStream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function resolveConversation(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  requestedConversationId: unknown,
  question: string,
): Promise<{ id: string } | { error: string }> {
  if (typeof requestedConversationId === "string") {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", requestedConversationId)
      .eq("user_id", userId)
      .single();
    return error || !data ? { error: "Conversation not found." } : data;
  }

  const title = question.length <= 80 ? question : `${question.slice(0, 79)}…`;
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title })
    .select("id")
    .single();
  return error || !data ? { error: "Unable to create a conversation." } : data;
}

/**
 * Failure reasons are stored as short, bounded strings. Raw error objects can
 * carry request fragments and provider detail that do not belong in a durable
 * record of someone's intellectual history.
 */
function toObservationReason(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown failure.";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

function hashUserId(userId: string) {
  return createHash("sha256").update(userId).digest("hex").slice(0, 64);
}

async function persistFailedAssistantMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  content: string,
) {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content,
    status: "failed",
    completed_at: new Date().toISOString(),
  });
  if (error) console.error("Unable to persist failed assistant message", error);
}
