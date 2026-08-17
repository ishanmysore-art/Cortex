# Cortex V2 — Architecture & Implementation Plan

**Status:** Parts 1–7 are the original proposal. **Milestones 1–6 have since been implemented** — see Parts 8–13 for what actually shipped and how it differs from the proposal.
**Method:** every claim in Parts 1–7 is grounded in a file/line in this repository as of `2a1e495`. Docs were read but treated as untrusted; code and SQL are the source of truth.

> Audit findings fixed by Milestone 1 are marked **✅ Fixed in M1** inline below. Everything else in Part 1 still stands.

---

# Part 1 — Current System Audit

## 1.1 What Cortex actually does today

Cortex is a **single-user-shaped, private RAG knowledge base**. A user signs up, uploads PDF/Markdown/text files, those files are parsed → chunked → embedded → stored in pgvector, and the user can then run semantic search or ask cited questions against them. There is a small manual "memory" list of user-typed strings that get injected into every Ask prompt.

There is **no cognitive modeling of any kind** in the codebase. Not partial, not stubbed. The word "learning" appears only in the ROADMAP's "You learn:" pedagogical notes. `memories` (`content TEXT`, max 1000 chars) is the entire user model, and it is 100% hand-typed by the user.

That is not a criticism of the build — the RAG half is genuinely more careful than most. It's a scoping fact: **V2 starts from zero on Layers 2–5, and from a solid base on Layer 1.**

## 1.2 Actual architecture

```
Browser
  │
  ├─ proxy.ts ────────────► lib/supabase/middleware.ts
  │   (Next 16 renamed middleware→proxy; this repo is correct)
  │   refreshes session, redirects /dashboard when anon
  │
  ├─ Server Components ──► app/(app)/dashboard/{page,notes,search,ask}
  │
  ├─ Server Actions ─────► app/actions/{documents,search,memories,auth}.ts
  │
  └─ Route Handlers ─────► app/api/ask, /api/health, /api/internal/ingestion

                    Supabase (Postgres 17.6 + pgvector + Storage + Auth)
                    RLS on every table; service-role only in the worker
```

Nine tables total: `documents`, `document_chunks`, `ingestion_jobs`, `conversations`, `messages`, `message_citations`, `memories`, `ai_usage_events`, `rate_limit_buckets`. Three SQL functions: `match_document_chunks`, `claim_ingestion_jobs`, `consume_rate_limit`.

## 1.3 Current data flow

**Ingest** (`app/actions/documents.ts` → `lib/ingestion/processor.ts`)

```
upload → validateUpload (10MB, ext+mime allowlist)
       → consume_rate_limit('upload')
       → Storage.upload({user_id}/{uuid}.{ext})
       → documents INSERT status='pending'
       → ingestion_jobs INSERT status='queued'
       → void processQueuedIngestionJobs()          ← fire-and-forget, unreliable
                     ▲
                     └─ also called by Vercel cron every 2 min

worker: claim_ingestion_jobs (SKIP LOCKED, attempts++, status='processing')
       → Storage.download
       → extractDocumentFromFile (unpdf per-page, or file.text())
       → chunkTextWithMetadata (700 tok, 100 overlap, paragraph→sentence→token,
                                preserves charStart/charEnd + pageStart/pageEnd)
       → embeddings in batches of 96, input = "Document Title: X\n\n{chunk}"
       → DELETE all chunks for doc, then INSERT in pages of 250   ← idempotent-ish
       → documents.status='ready', processed_at, content_hash
       → ingestion_jobs.status='completed'
```

**Ask** (`app/api/ask/route.ts`)

```
POST /api/ask
 → validate, auth, consume_rate_limit('ask')
 → resolve/create conversation, INSERT user message
 → parallel: last 10 messages | top 8 active memories by updated_at | retrieval
 → retrieval: 1–2 embedded queries → match_document_chunks(thr=0.2, k=30)
              → dedupe → selectDiverseChunks (round-robin across documents)
 → INSERT assistant message status='streaming'
 → openai.responses.create (DRAFT)          ← awaited fully, not streamed
 → openai.responses.create (VERIFY)         ← second full pass over the draft
 → validateGroundedAnswer (deterministic numeric/citation gate)
 → pick candidate | draft | "I couldn't find evidence…"
 → UPDATE message, INSERT message_citations (with title+excerpt SNAPSHOTS)
 → recordAiUsage
 → open SSE stream, emit meta + ONE delta containing the entire answer + done
```

## 1.4 What is implemented — claimed vs. actual

| Feature | Claimed | Actually implemented | Evidence | Status |
|---|---|---|---|---|
| Supabase auth + RLS + protected routes | README, ROADMAP M2 | Yes | `proxy.ts`, `lib/supabase/middleware.ts:34-48`, `app/(app)/layout.tsx:9-17` | ✅ Works |
| Upload → Storage → `documents` | ROADMAP M4 (unmarked) | Yes | `app/actions/documents.ts:32-78` | ✅ Works, roadmap stale |
| Chunking with source offsets + page ranges | README | Yes, and it's good | `lib/documents/chunker.ts:31-128` | ✅ Works |
| Embeddings + pgvector | ROADMAP M5 (unmarked) | Yes | `lib/ingestion/processor.ts:68-97`, migration `20260719010000` | ✅ Works |
| Semantic search | ROADMAP M6 (unmarked) | Yes | `app/actions/search.ts:44-75` | ✅ Works |
| Durable, retryable ingestion jobs | README, ROADMAP M7 | Yes — originally with **no stale-lock recovery** | `claim_ingestion_jobs` (migration:99-119) | **✅ Fixed in M1** |
| Grounded RAG with page-aware citations | README, ROADMAP M7 | Yes, with immutable evidence snapshots | `message_citations` (migration:164-176), `route.ts:239-253` | ✅ Works — best asset in repo |
| **"Streaming Responses API generation"** | README line 3, ROADMAP M7 | **No.** Fully awaited, then one SSE `delta` with the whole answer | `route.ts:180-203` (no `stream:true`), `route.ts:271-298` | ❌ **Doc is wrong** |
| Prompt-cache metrics | README | Yes, recorded | `route.ts:260-269`, `ai_usage_events` | ✅ Works |
| Per-user rate limits | README | Yes, fail-closed fixed window | `consume_rate_limit` (migration:242-288), `lib/rate-limit.ts:15-17` | ✅ Works |
| "Durable memory, opt-in" | README | Yes — a plain text list, no embedding, no provenance, no types | `memories` (migration:195-212), `route.ts:91-97` | ⚠️ Not a user model |
| Milestone 3 is "current" | ROADMAP | M3 shipped; M7 & M8 also marked ✅ | ROADMAP internally contradictory | ❌ Stale |
| `app/(marketing)/` route group | ROADMAP folder structure | Doesn't exist; landing is `app/page.tsx` | `find app -type d` | ❌ Stale |
| Vercel cron every 2 min | README, `vercel.json` | Configured, but Hobby plan only permits daily crons | `vercel.json:5` | ⚠️ Silently degrades |
| Worker secret configured | README, runbook | **`.env.local` has no `CRON_SECRET`/`INTERNAL_WORKER_SECRET`** | `.env.local` key list | ❌ `/api/internal/ingestion` 401s locally; `check:env` fails |
| Any learner/cognitive model | Product vision | **None** | No table, no column, no code path | ❌ Layer 2–5 = greenfield |

**End-to-end RAG verdict:** functional. The pipeline is coherent from upload to cited answer, `tsc --noEmit` is clean, and 24 tests pass. The failure modes below are real but they are *operational*, not structural.

## 1.5 Bugs and risks, ranked

**1. Permanent ingestion deadlock (high).** — **✅ Fixed in M1**
`claim_ingestion_jobs` only claims `status IN ('queued','retry')` (migration:102). Nothing anywhere resets `processing`. There is no reaper, no `locked_at` timeout, no cron sweep. If the process dies mid-job the row stays `processing` forever. Worse: `ingestion_jobs_active_document_key` is a partial unique index that *includes* `processing` (migration:65-67), so that document can never be re-enqueued either. The document is bricked, and `DocumentList` will poll `router.refresh()` every 3s forever (`document-list.tsx:117-123`).

This isn't hypothetical — `app/actions/documents.ts:81` does `void processQueuedIngestionJobs(...)` fire-and-forget inside a Server Action. On a serverless host, work started after the response returns is routinely killed. That is precisely the crash that produces the stuck state.

**2. Cross-tenant work stealing (medium).** — *still open*
That same fire-and-forget claims a **global** batch of up to 3 jobs, not the uploader's. User A's upload can spend User A's request budget embedding User B's documents — and hold locks it may not survive to release. M1 removed the "may not survive to release" half by moving the call into `after()` and adding reclaim; the global-batch behaviour is unchanged and is deliberately left for the queue rework.

**3. Fake streaming (medium, UX).**
Two sequential full model calls (draft + verify, 1200 max output tokens each) complete before a single byte reaches the client. Time-to-first-token is roughly double a normal answer, with a static "Thinking…" the whole time. The SSE plumbing exists; only the generation is non-streaming.

**4. RLS lets a user forge document state (medium).**
`documents` UPDATE policy has no column restriction (migration `20260718180100`:29-32). A user can `PATCH status='ready'` on a document that never ingested, or clear `extraction_error`. Separately, users can INSERT into `ingestion_jobs` directly, bypassing the `upload` rate limit entirely.

**5. HNSW recall collapses under multi-tenancy (high, latent).**
`match_document_chunks` orders by a **global** HNSW index and *then* filters `d.user_id = auth.uid() AND d.status='ready'` (migration `20260806190000`:31-37). With default `hnsw.ef_search`, once a user owns a small fraction of total chunks the index returns mostly other users' rows, which get filtered out — silently returning far fewer than `match_count`. Invisible at one user. A correctness cliff, not a performance one. `document_chunks` has no `user_id` column at all, so there is currently no way to build a partial or partitioned index.

**6. `match_threshold: 0.2` is a no-op.**
For `text-embedding-3-small` cosine similarity, essentially every chunk clears 0.2. Retrieval quality rests entirely on top-k and `selectDiverseChunks`.

**7. One user's research corpus is hardcoded into the retrieval engine (high, debt).**
`lib/rag/retrieval.ts:60-72` appends the literal string `"participant sample size ADHD control pediatric adult dataset details"` to any query matching a regex. This is one specific paper leaking into shared library code, and it is enshrined in the test suite (`tests/retrieval.test.ts:63`). It will actively degrade retrieval for any other corpus.

**8. The grounding validator is a blunt instrument that silently destroys good answers (high).**
`validateGroundedAnswer` (retrieval.ts:278-308) rejects an answer if *any* numeric token in a cited sentence isn't literally present in the cited passage. To paper over the false positives, it whitelists `page_start`, `page_end`, and `chunk_index` into the "cited content" haystack (lines 293-301). Net effect: a legitimate "across 3 documents" fails, while a hallucinated number that happens to equal a page number passes. On failure the user gets "I couldn't find evidence for this…" even when retrieval was perfect.

This matters far beyond RAG quality. The system's entire epistemic stance is **"inference is forbidden"** — see `ASK_INSTRUCTIONS`: *"Do not calculate or infer a number unless the user explicitly asks."* Layers 3 and 4 of the V2 vision are **nothing but inference**. V2 cannot inherit this stance. It must replace *ban inference* with *label inference*.

**9. No `user_id` denormalization (medium).**
`document_chunks`, `messages`, and `message_citations` all reach the user through correlated `EXISTS` subqueries. Every read pays a join, per-user export/erasure is a multi-hop walk, and per-user partitioning is impossible.

**10. `memories` is not a user model (structural).**
No embedding, no type, no confidence, no validity interval, no evidence beyond a nullable `source_message_id`. Top-8-by-`updated_at` are injected into *every* prompt regardless of relevance. This degrades answers somewhere around 20 memories.

**11. Account deletion leaves orphaned Storage objects.**
DB rows cascade from `auth.users`; Storage objects do not. `deleteDocument` handles the per-document case, but there is no account-deletion path — a hard blocker for the privacy posture V2 requires.

**12. Testing gap (high).**
24 tests, all pure functions in retrieval/chunker/validation. Zero coverage of the ingestion state machine, the RLS policies, the three SQL functions, `/api/ask`, or auth. The two most failure-prone subsystems — job lifecycle and RLS — have none.

**13. Minor.** `extractTextFromFile` (parsers.ts:14) and `chunkText` (chunker.ts:4) are dead exports. `brain/scratch/` is empty. `.cursorrules` is empty. `lib/openai/client.ts:5` falls back to `"dummy-key-for-tests"`, so a misconfigured deploy fails with an opaque OpenAI 401 at request time instead of at boot.

## 1.6 Can this architecture support V2? — the rewrite question

**Verdict: extend. A rewrite is not justified, and here is the proof obligation discharged.**

Three things the current system already gets right, and which are exactly what a cognitive model needs:

1. **Stable, addressable provenance anchors.** `document_chunks.id` + `char_start/char_end/page_start/page_end` means any claim can point at an exact span of an exact source. Most RAG apps cannot do this. Building an evidence layer on top requires no re-ingestion.

2. **`message_citations` is already an immutable evidence record.** It stores `document_title_snapshot` and `excerpt_snapshot` — evidence that survives the source being edited or deleted (migration:164-176). This is, almost certainly by accident, the most V2-aligned design decision in the repository. The V2 evidence layer is a **generalization of this exact pattern**, not a replacement for it.

3. **Postgres + pgvector + RLS is the correct substrate.** An event log, a graph, and embeddings in one transactional store with row-level tenancy is precisely what an evidence-graph product wants. Splitting into a separate vector DB or graph DB now would buy nothing and cost transactional integrity across the log and its projections.

The one genuine structural gap: **there is no event log.** `ai_usage_events` is billing telemetry (operation, tokens, latency) — it records that an ask happened, not what happened *cognitively*. Today, everything knowable about the user is recoverable only by re-reading conversation prose with an LLM. That is the hole, and it is additive to fill.

**What must change (all in-place, none of it a rewrite):**
- Add `user_id` denormalization + a partial-index strategy for vector search.
- Decompose `/api/ask` — it is currently a 350-line route doing retrieval, prompting, verification, validation, persistence, and transport. V2 needs observable, individually testable stages.
- Delete the corpus-specific hacks.
- Replace the pass/fail numeric gate with claim *typing*.

---

# Part 2 — V2 Architecture

## 2.1 The one architectural principle

> **One append-only observation log. Everything else is a derived, versioned, evidence-linked projection that can be thrown away and rebuilt.**

If Cortex's model of a person can't be rebuilt from the log, then that model is unfalsifiable, un-auditable, and un-improvable — which makes it indistinguishable from a horoscope with an API bill.

## 2.2 System architecture

```
   Documents      Conversations       Behavior/Outcomes
        │                │                    │
        └────────────────┼────────────────────┘
                         ▼
         ┌───────────────────────────────┐
         │   observations  (append-only) │   ← immutable, bitemporal, the ONLY truth
         └───────────────┬───────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   evidence  (typed links)     │   ← observation ──relation──► claim
         └───────────────┬───────────────┘
                         │
      ┌──────────────────┼──────────────────┐
      ▼                  ▼                  ▼
  concepts /        knowledge_states     user_claims
  concept_edges     (mastery, retrieval) (belief|interest|goal|
  (knowledge graph) (learner model)       question|hypothesis)
      │                  │                  │      (cognitive model)
      └──────────────────┼──────────────────┘
                         ▼
              interventions → outcomes        (personalization ledger)
                         ▼
                     notices                  (proactive agent)
                         ▼
                 user response  ─────────────► back into observations  ∞
```

Note the loop closure at the bottom. A proactive notice the user dismisses is *itself an observation*. That loop is the only honest source of "did this actually help?" — and it's the thing that makes the dataset non-replicable.

## 2.3 Data architecture: store / derive / never-store

| Category | Contents | Rule |
|---|---|---|
| **Append-only, immutable** | `observations`, `claim_evidence`, `message_citations`, `interventions`, `notices` + responses | Never UPDATE. Delete only on user erasure. |
| **Mutable projection, rebuildable** | `concepts`, `concept_edges`, `knowledge_states` | Safe to `TRUNCATE` and rebuild from the log. Carry a `derived_through_observation_id` watermark. |
| **Immutable rows, mutable set** | `user_claims` | A revision INSERTs a new row and sets `superseded_by` on the old. Never edit history. |
| **pgvector** | chunk embeddings (exists), concept embeddings, claim `statement_embedding` | Nothing else. Embeddings are for *finding*, never for *storing meaning*. |
| **Raw source** | document bytes in Storage | Already correct. |
| **Never stored** | "learning style", personality summaries, aggregate mastery scores, trajectory narratives | Any *characterization of the person* is computed on demand, rendered with its evidence, and never persisted as an attribute. |

That last row is the whole product thesis in one line. The moment Cortex writes `profile.learning_style = 'example-based'`, it has become a personality quiz.

**JSONB vs. relational:** relational for anything you will filter, join, aggregate, or index on — `claim_type`, `status`, `confidence`, `user_id`, all timestamps. JSONB only for `payload`/`context`: the per-kind variable part that is always read whole. The failure mode to avoid is a `metadata jsonb` column that quietly becomes the real schema.

## 2.4 Event model — `observations`

```
observations
├── id              uuid pk
├── user_id         uuid  (denormalized, RLS + future partition key)
├── kind            enum   -- see below
├── occurred_at     timestamptz  -- when it happened in the user's world
├── recorded_at     timestamptz  -- when Cortex learned it
├── actor           enum ('user' | 'cortex' | 'system')
├── source_kind     enum ('document'|'user_stated'|'system_measured'
│                        |'model_inferred'|'user_corrected')
├── subject_type    enum ('document'|'chunk'|'concept'|'message'|'claim'|'notice')
├── subject_id      uuid
├── context         jsonb  -- conversation_id, message_id, span offsets…
├── payload         jsonb  -- kind-specific
├── confidence      numeric null   -- only for model_inferred
├── dedupe_key      text null      -- unique per user; idempotent writers
└── (no updated_at — this table is never updated)
```

Starting `kind` set, deliberately small — only what M1–M4 can actually emit honestly:

`document_ingested` · `concept_encountered` · `question_asked` · `explanation_given` · `evidence_cited` · `claim_stated` · `claim_revised` · `retrieval_attempted` · `retrieval_succeeded` · `retrieval_failed` · `notice_surfaced` · `notice_accepted` · `notice_dismissed` · `correction_issued`

Resist adding `user_forgot_X`. Forgetting is not observable — it is *inferred* from `retrieval_failed` at time T after `retrieval_succeeded` at time T−n. Putting it in the log as a fact is exactly the category error this architecture exists to prevent.

## 2.5 Knowledge model

```
concepts        (id, user_id, label, canonical_label, embedding vector(1536),
                 first_seen_at, last_seen_at)
concept_mentions(id, user_id, concept_id, chunk_id|message_id, observation_id,
                 char_start, char_end)        -- every concept traces to a span
concept_edges   (id, user_id, from_concept, to_concept, relation, weight,
                 evidence_count, updated_at)
```

Hard rule: **a `concept` may not exist without ≥1 `concept_mention`.** That is what turns "your work on A connects to B" from a vibe into a checkable statement with two clickable spans.

Extraction runs inside the existing ingestion worker — it already holds the text and the chunk IDs. No new pipeline, no re-ingestion.

## 2.6 Learner model — `knowledge_states`

```
knowledge_states (user_id, concept_id) PK
├── mastery_estimate          numeric      -- derived, not asserted
├── mastery_method            text         -- how it was computed; always present
├── retrieval_attempt_count   int
├── retrieval_success_count   int
├── last_retrieved_at         timestamptz
├── last_encountered_at       timestamptz
├── derived_through_obs_id    uuid         -- rebuild watermark
└── updated_at                timestamptz
```

Deliberately **no forgetting curve, no half-life, no SM-2 parameters yet.** Store the retrieval history faithfully; fit a retention model in year two when there is real longitudinal data. Shipping a half-life parameter fitted on eleven data points is how you get a confident number that means nothing.

## 2.7 Cognitive model — `user_claims`

This is the single most important table in V2, and its design is where most products in this space go wrong.

```
user_claims
├── id                  uuid pk
├── user_id             uuid
├── claim_type          enum ('belief'|'interest'|'goal'|'question'
│                            |'hypothesis'|'preference'|'misconception')
├── statement           text
├── statement_embedding vector(1536)   -- for contradiction + relevant recall
├── asserted_by         enum ('user'|'cortex')     ← NEVER merged
├── status              enum ('active'|'revised'|'retracted'|'rejected_by_user')
├── confidence          numeric
├── confidence_method   text            -- "0.8" must always have a story
├── valid_from          timestamptz
├── valid_to            timestamptz null
├── superseded_by       uuid null self-fk
├── created_at          timestamptz
└── CHECK: asserted_by='cortex' ⇒ ≥1 claim_evidence row   (trigger-enforced)
```

Four design decisions, each load-bearing:

1. **`asserted_by` is never collapsed.** "You said you believe X" and "Cortex infers you believe X" are categorically different objects. They get different columns, different UI treatment, different retrieval weight, and different deletion semantics. Merging them is the exact failure the brief calls out — turning *"Cortex thinks the user learns better through examples"* into *"the user is an example-based learner."*

2. **Revision is INSERT + `superseded_by`, never UPDATE.** This is what makes *"which of my ideas have changed?"* a `SELECT`, not a guess. It's also what makes "what did Cortex believe about me last March?" answerable — the difference between a research artifact and a chatbot.

3. **`statement_embedding` is not optional.** Contradiction detection ("two ideas you've expressed appear inconsistent") is a nearest-neighbour search over claims with opposed polarity. Without the embedding it's an O(n²) LLM sweep, which is unaffordable and unreliable.

4. **The evidence CHECK is mechanically enforced, not a convention.** *No evidence, no Cortex claim.* A trigger, not a code comment. This is the single mechanism that keeps the system from drifting into confident nonsense as the LLM improves at sounding sure.

## 2.8 Evidence / provenance model — `claim_evidence`

```
claim_evidence
├── id, user_id
├── claim_id         uuid → user_claims
├── observation_id   uuid → observations
├── relation         enum ('supports'|'contradicts'|'originates')
├── weight           numeric
└── excerpt_snapshot text     -- generalizes message_citations; survives source deletion
```

Five source kinds, never collapsed into each other:

| `source_kind` | Means | Example |
|---|---|---|
| `document` | Your source says X | chunk id + offsets — **works today** |
| `user_stated` | You said X | message id + span |
| `system_measured` | You did X | "answered 4/5" |
| `model_inferred` | Cortex infers X | requires ≥1 supporting observation + method + confidence |
| `user_corrected` | You told Cortex it was wrong | **highest precedence, always wins** |

**Rendering contract:** every Cortex statement about the user must be renderable as

> `<claim>` · confidence `<c>` · `<n>` observations · `[inspect]`

If a statement cannot be rendered that way, the UI is not permitted to show it. Enforce this at the component level so it can't be forgotten under deadline.

## 2.9 Temporal model

Three clocks, always distinguished:

- `occurred_at` — when it happened in the user's world
- `recorded_at` — when Cortex learned it
- `valid_from` / `valid_to` — when the claim was *true of the user*

Two clocks is a log. Three is a model that can answer *"what did Cortex believe about me six months ago, and was it right?"* — which is the only way to ever evaluate whether the cognitive model works.

## 2.10 Personalization engine (ledger only, for now)

```
interventions        (id, user_id, kind, strategy, concept_id, message_id,
                      delivered_at, params jsonb)
intervention_outcomes(id, intervention_id, outcome_observation_id,
                      measured_at, delta jsonb)
```

Record faithfully. **Analyze in year two.** Building a policy learner before there is a single week of data is the fastest route to a system that confidently personalizes on noise. The architecture's job right now is only to make the future analysis *possible* — and possible means: the intervention, the strategy label, and the *later* measured outcome are all linked and timestamped.

## 2.11 Proactive intelligence

```
notices (id, user_id, kind, payload jsonb, evidence_observation_ids uuid[],
         surfaced_at, user_response enum, responded_at)
```

Each notice kind maps to a query that must already be answerable from the schema:

| Notice | Query it reduces to |
|---|---|
| Connection | shared `concept_edges` across documents in different projects |
| Forgotten knowledge | `retrieval_succeeded` at T−n, no successful retrieval since, concept re-encountered |
| Contradiction | two `active` claims, high embedding similarity, opposed polarity |
| Emerging interest | rising `concept_mentions` rate over a trailing window |
| Recurring question | repeated `question_asked` observations clustering to one concept |
| Knowledge gap | high `concept_mentions`, low `retrieval_success_count` |

Every one of these is a SQL query over the log plus one embedding lookup. **None of them requires an LLM to decide *whether* to fire** — the LLM only phrases the notice. That separation is what keeps proactive intelligence from becoming a random-nag generator.

---

# Part 3 — What NOT to Build Yet

**Build now** — no new data required, unlocks everything else:
- Observation log + evidence links
- Concept extraction at ingest + mentions
- **User-stated** claim capture only
- The inspection UI: "what does Cortex know about me, and why"
- Real token streaming
- The ingestion job reaper

**Build later** — blocked on data volume, not on engineering:
- Retention/forgetting estimation — needs months of retrieval events
- Contradiction detection — needs claim volume + embeddings
- Proactive notices — needs concepts + claims + a response loop
- Intervention outcome analysis — needs dozens of interventions *per strategy*

**Research / moonshot — do not build:**
- **A personalization policy learner.** You cannot run a controlled experiment on n=1 with unmeasured confounds (sleep, mood, workload, topic difficulty). Anything you "learn" in the first year is overfitting with extra steps.
- **EEG / physiological signals.** No data, no validation path, and it pulls hard toward medical claims. Correct treatment: the schema already accepts it as a `source_kind` and `system_measured` observation. That is the entire investment. Do nothing else.
- **"Reasoning pattern" classification.** Currently indistinguishable from LLM vibes. Needs a defensible taxonomy with inter-rater reliability before it's more than astrology.
- **Automatic belief extraction from documents the user merely read.** *Reading is not believing.* This is the most tempting feature in the whole vision and the most wrong. A user reading a paper on a theory they think is garbage would have that theory recorded as their belief. Beliefs come from `user_stated` and `user_corrected` only, at least until there's a validated inference method.

---

# Part 4 — Milestone Roadmap

### M0 — Stabilize the foundation *(prerequisite for trustworthy data)*

**Goal.** Fix the failure modes that would corrupt every downstream measurement.
**Why.** An event log built on top of an ingestion pipeline that silently bricks documents produces a cognitive model built on gaps. Data quality problems here are *unrecoverable* — you can't retroactively know what a user would have asked about a document that never became ready.
**Deps.** None.
**Files.** `lib/ingestion/processor.ts`, `app/actions/documents.ts`, `app/api/ask/route.ts`, `lib/rag/retrieval.ts`, `vercel.json`, `.env.local`.
**DB.** Reaper function (reset `processing` where `locked_at < now() - interval '15 min'` and `attempts < max_attempts`); `user_id` on `document_chunks` backfilled + NOT NULL; restrict the `documents` UPDATE policy off `status`; drop the user INSERT policy on `ingestion_jobs`.
**API.** `/api/internal/ingestion` also runs the reaper. Real `stream: true` on the draft call.
**Frontend.** `ask-chat.tsx` already handles incremental `delta` events — no change needed.
**Backend.** Drop `isComprehensiveDatasetQuery` + the ADHD query-expansion string. Replace the binary `validateGroundedAnswer` gate with claim typing (supported / interpretation / unsupported) so inference becomes *labeled* rather than *banned*.
**Tests.** Job lifecycle including crash-mid-job → reaper → retry → success. RLS policy tests (user A cannot read/forge user B). SSE incremental delivery.
**Acceptance.** Kill a worker mid-job; the document reaches `ready` within one reaper cycle without manual intervention. First token < 1.5s. No corpus-specific strings in `lib/`.
**Unlocks.** Everything — M1 data is only as good as this.

---

### M1 — The observation + evidence spine ⭐ *(see Part 5)*

**Goal.** Every meaningful interaction writes an immutable, evidence-linked observation.
**Why.** This is the only component that cannot be backfilled. Documents can be re-ingested, concepts re-extracted, embeddings recomputed — but *the fact that the user asked about X on Tuesday and pushed back on the answer* is gone forever if it isn't captured when it happens.
**Deps.** M0.
**Files.** New `lib/observations/{recorder,kinds}.ts`; call sites in `app/api/ask/route.ts`, `app/actions/{documents,search,memories}.ts`, `lib/ingestion/processor.ts`.
**DB.** `observations` + `claim_evidence` + enums; RLS; `(user_id, occurred_at DESC)` and `(user_id, kind, occurred_at DESC)` indexes; unique `(user_id, dedupe_key)`.
**API.** No new public endpoints. `recordObservation()` is called inline in existing paths, fire-safe (a logging failure must never fail a user request).
**Frontend.** None. **This milestone is deliberately invisible to the user.**
**Backend.** Emit `document_ingested`, `question_asked`, `explanation_given`, `evidence_cited` (one per citation, linked to the existing `message_citations` row).
**Tests.** Every emitting path writes exactly one observation; idempotency under retry via `dedupe_key`; a recorder failure does not fail the parent request; RLS isolation.
**Acceptance.** After a normal session — upload, search, ask, follow-up — the log alone reproduces the full session narrative with correct ordering and provenance, with no reliance on re-reading message prose.
**Unlocks.** M2–M7. All of them.

---

### M2 — Concept layer

**Goal.** Extract concepts at ingest; link every one to a source span.
**Why.** Concepts are the join key between the knowledge model and the cognitive model. Without them you cannot connect "what you read" to "what you know" to "what you're interested in."
**Deps.** M1.
**Files.** `lib/ingestion/processor.ts` (new stage after chunking), new `lib/concepts/extractor.ts`.
**DB.** `concepts`, `concept_mentions`, `concept_edges`; HNSW on `concepts.embedding`.
**API.** None.
**Frontend.** Concepts visible on the document detail view.
**Tests.** Extraction determinism at temperature 0; every concept has ≥1 mention with valid offsets; re-ingest is idempotent.
**Acceptance.** Upload two related papers → shared concepts are detected and each is clickable through to the exact source span.
**Unlocks.** M4, M6 (connection + gap notices).

---

### M3 — User-stated claims + the inspection UI

**Goal.** Capture beliefs/goals/questions the user *actually states*, and ship the "what does Cortex know about me" page.
**Why.** This is the first milestone the user can feel, and shipping inspection *simultaneously* with the first claims sets the product's norm permanently: nothing is ever stored about the user that they can't see and correct.
**Deps.** M1.
**Files.** New `app/(app)/dashboard/model/page.tsx`, `lib/claims/*`; extends the existing `memories` UI.
**DB.** `user_claims` + the evidence-requirement trigger. Migrate existing `memories` rows → `user_claims(asserted_by='user', claim_type='preference')`.
**API.** Server actions: state / revise / retract / correct.
**Frontend.** Model inspection page — grouped by type, each row showing confidence, evidence count, and an inspect drawer.
**Tests.** Revision creates a new row and never mutates the old; retraction preserves history; the trigger rejects a `cortex` claim with no evidence.
**Acceptance.** A user can state a belief, revise it, and see both versions with dates and evidence. `memories` is fully migrated with no data loss.
**Unlocks.** M5, M6 (contradiction).

---

### M4 — Knowledge states + retrieval events

**Goal.** Record retrieval attempts/successes per concept; maintain a rebuildable mastery projection.
**Deps.** M1, M2.
**DB.** `knowledge_states` + a rebuild function driven off the observation watermark.
**Tests.** `TRUNCATE knowledge_states` → rebuild from log → byte-identical result. This test is the whole point of the milestone.
**Acceptance.** The projection is provably a pure function of the log.
**Unlocks.** M6 (forgotten-knowledge, gap notices), M7.

---

### M5 — Cortex-inferred claims

**Goal.** Cortex may assert claims about the user — only with linked evidence and a stated method.
**Deps.** M3, M4.
**Backend.** Batch inference job (not inline in Ask). Every inferred claim writes its `claim_evidence` rows in the same transaction.
**Frontend.** Inferred claims render visually distinct from user-stated ones, with a prominent "this is wrong" control.
**Tests.** No inferred claim can be committed without evidence; `user_corrected` always supersedes.
**Acceptance.** Every inferred claim answers "why do you believe that?" with real observations. A correction is durable and outranks re-inference.
**Unlocks.** M6, M7.

---

### M6 — Proactive notices + response loop

**Goal.** "Cortex noticed something" — with the user's response fed back as an observation.
**Deps.** M2, M3, M4, M5.
**Backend.** Scheduled detectors (SQL + embedding queries, one per notice kind). The LLM phrases; it does not decide whether to fire.
**Acceptance.** Each notice cites its evidence. Dismissals are recorded and suppress that notice kind for that subject.
**Unlocks.** M7 — and this is the first milestone where the product stops being "ask your notes."

---

### M7 — Intervention ledger

**Goal.** Record what Cortex did and what measurably followed.
**Deps.** M4, M6.
**Scope discipline.** Recording only. **No policy learning.** Revisit after ≥6 months of data.

---

# Part 5 — First Implementation Milestone

## **M1 — The observation + evidence spine.** (With M0's reaper as a blocking prerequisite.)

**Why this and nothing else.**

**1. It is the only component that cannot be backfilled.** Every other asset is recoverable. Lose the concepts — re-extract them. Lose the embeddings — recompute. Lose the log — the history is *gone*, permanently. Every day shipped without it is a day of irreplaceable longitudinal data destroyed. For a product whose entire thesis is longitudinal modeling, that is the only urgency that actually exists.

**2. It forces the epistemics before there's anything to be dishonest about.** Writing `source_kind` and `actor` into the schema *before* the first inference exists means the distinction between "you said" and "Cortex guessed" is structural rather than aspirational. Retrofit that after shipping a profile feature and it never happens — the shortcut is always cheaper in the moment.

**3. It's cheap and reversible.** Two tables and a `recordObservation()` helper called from paths that already exist. No user-visible surface, no new endpoints, no migration risk to working RAG. If the model of the world turns out wrong, you've written an append-only log — the least costly thing to have been wrong about.

**4. It converts every later milestone from research into engineering.** Contradiction detection, forgetting curves, proactive notices, intervention analysis: each is a query over this log. Without it, each is a bespoke LLM-on-prose pipeline that is slow, expensive, and unverifiable.

**5. It's the moat, and it starts compounding on day one.** Anyone can ship a chatbot over documents in a weekend. Nobody can ship *your user's eighteen months of timestamped, evidence-linked cognitive history.* The log is the asset. It has to start existing before it can start compounding.

**Explicitly out of scope for M1:** no UI, no inference, no concepts, no claims. If M1 touches a React component, it has grown wrong.

---

# Part 6 — Risks

**Technical**
- The reaper is a band-aid on fire-and-forget ingestion. The real fix is a proper queue (pg_cron sweep, or Supabase Edge Function on a schedule). Plan for it.
- The observation log grows unboundedly. At ~100 observations/day/user it's trivial for years; design the partition key (`user_id`) now, execute later.
- HNSW multi-tenant recall (§1.5.5) becomes a *correctness* bug the moment there's a second real user. Fix in M0, not when it's noticed in production.

**Architectural**
- **Projection drift.** If `knowledge_states` ever becomes writable outside the rebuild path, the log stops being the truth and the architecture silently degrades to a normal CRUD app. The M4 rebuild-equality test is the guard; treat it as a release gate, not a nice-to-have.
- **Observation-kind sprawl.** Every new `kind` is a permanent schema commitment against immutable rows. Adding kinds is easy; removing them requires rewriting history. Add reluctantly.
- **`/api/ask` is already a 350-line god-route.** M1 adds calls to it. If it isn't decomposed during M0/M1 it will be unmaintainable by M5.

**Product**
- The gap between "RAG over my PDFs" and "cognitive model" is roughly M1–M6. That's a long stretch with limited visible payoff. M3's inspection UI is deliberately placed early to make the thesis tangible before M6.
- Cold start: the cognitive model is worthless for weeks. Notices before there's real signal will feel like noise and burn trust permanently. Gate notices on evidence thresholds, not on a ship date.

**Privacy**
- This system is *designed* to accumulate an unusually intimate record of someone's intellectual life. That obligates, non-negotiably: full export, real deletion (including Storage objects — currently broken, §1.5.11), per-observation deletion, and visibility into everything inferred.
- **Deletion vs. an append-only log is a genuine tension.** Resolution: user erasure is the one permitted DELETE, and it must cascade observation → evidence → dependent claims, followed by a projection rebuild. Design this in M1's migration, not later — retrofitting deletion into an append-only system is brutal.
- Sending intellectual history to a third-party model is a materially bigger disclosure than sending document chunks. `store: false` is already set (route.ts:187); that's necessary and not sufficient. Users should understand and consent to what leaves the box.

**AI hallucination / epistemic**
- The central risk of the entire V2 vision: **a fluent LLM producing confident, evidence-free claims about a person's mind.** The mechanical defenses are the evidence trigger on `user_claims`, the `asserted_by` split, and the rendering contract (§2.8). Convention alone will not hold — enforce in the database and in the component layer.
- **Inference laundering.** "Cortex infers with 0.6 confidence that you may prefer X" becomes "You prefer X" the moment someone writes a summary prompt over the claims table. Every prompt that reads `user_claims` must carry `asserted_by` and `confidence` into its output, and this needs a test.
- **The existing codebase has the opposite bias.** `ASK_INSTRUCTIONS` bans inference outright; V2 depends on it. Do not resolve this by loosening the RAG prompt — resolve it by *separating* the surfaces: document Q&A stays strictly grounded; claims about the user are always labeled and evidence-linked. Two different epistemic contracts, deliberately.
- Confidence numbers invented by an LLM are decoration. `confidence_method` exists so that every number has a derivation. If the method is "the model said so," say that.

**Scalability** — covered above; none of it binds before real multi-user load.

**"Generic AI wrapper" risk — the most serious one.**
Cortex today is, honestly, a well-built RAG app. The distance to "generic wrapper" is one product decision: shipping an LLM-generated user profile and calling it a cognitive model. That would look impressive in a demo, take a week, and destroy the thesis — because it's replicable in an afternoon and it's unfalsifiable by construction. **The defense is the evidence requirement.** A system that must justify every claim about you cannot be faked with a good prompt.

---

# Part 7 — Final Recommendation

**Build the ledger, not the profile.**

The differentiator is not the cognitive model. Any competent team can prompt an LLM into producing "here's what I know about you," and it will read well. The differentiator is the **auditability** of the cognitive model — and that is genuinely hard to replicate, because it isn't a prompt, it's an accumulated, verifiable history.

What nobody else can produce:

> "Here's what I believe about you. Here are the 17 timestamped observations behind it. Here's what I believed six months ago and how it changed. Here's the button that tells me I'm wrong — and my belief updates, with the correction preserved."

Architecturally, that means: **Cortex is an append-only observation log with a typed evidence layer, and every user-facing claim is a query against that log rendered together with its evidence.** The LLM is a projection function over the ledger. It is swappable, and it should be assumed to be swapped.

The test for whether the right thing got built: *in two years, can you run a better model over the same ledger and get a better cognitive model without losing a single day of history?* If yes, the architecture is right. If the model and the memory are entangled such that upgrading the model means starting over — it's a wrapper, regardless of how sophisticated it looks.

This is also why the vision compounds rather than commoditizes. As models get cheaper and better, a system whose value lives *in the prompt* gets less defensible every quarter. A system whose value lives in an eighteen-month evidence graph gets *more* valuable, because a better model extracts more from the same history.

---

## Two places where I'd push back on the brief

**1. The three-model decomposition is the wrong implementation boundary.**
The brief proposes Knowledge Model / Cognitive Model / Learner Model as parallel systems. They are not three subsystems — they are **three views over one evidence graph**. Building them as separate stores guarantees drift (three inconsistent answers about the same concept), triple-counted evidence (the same observation inflating confidence in three places), and three sync problems. One log, one evidence layer, three read models. This is why §2.2 collapses them.

**2. The current grounding philosophy is in direct conflict with the vision, and the conflict must be resolved deliberately.**
`ASK_INSTRUCTIONS` says *"Do not calculate or infer."* `validateGroundedAnswer` mechanically enforces it. Layers 3 and 4 of the vision are **entirely inference**. If that tension isn't resolved on purpose, it resolves itself by accident — someone loosens the RAG prompt to make the cognitive features work, and grounded document Q&A quietly regresses.

The correct resolution is not one policy but two surfaces with two contracts:

- **Documents** → strict grounding. Never infer. Cite or decline. (What exists today, minus the blunt numeric gate.)
- **The user model** → inference is the product, but every inference is typed, evidence-linked, confidence-bearing, and correctable.

Same evidence layer underneath. Opposite epistemic stances on top, by design rather than by drift.

**One factual correction to the brief's framing:** it describes Cortex as having begun as an "AI second brain" being evolved toward a cognitive model. In terms of shipped code, there is no partial cognitive model to evolve — `memories` is a hand-typed string list. That's good news, not bad: there is no wrong abstraction to unwind. Layer 1 is solid and worth keeping. Layers 2–5 are clean greenfield.

---

# Part 8 — Milestone 1 as built

Shipped: the ingestion recovery prerequisite and the observation spine. Deliberately **not** shipped: evidence links, claims, concepts, inference, and any UI.

## 8.1 Why observations are separate from inference

The whole milestone rests on one distinction:

| | Observation | Inference |
|---|---|---|
| Asserts | *an event occurred* | *something is true of the person* |
| Example | "the user saved a memory" | "the user believes X" |
| Falsifiable by | checking the source row | nothing, unless evidence is attached |
| Storage | `observations` (this milestone) | `user_claims` + `claim_evidence` (M3/M5) |
| Mutability | append-only | revisable, superseded, never edited |

`observations` contains no confidence column and no `model_inferred` source kind, because in M1 every row is by construction a record of something that actually happened. The epistemic-source distinction from §2.8 enters at the *evidence* layer, where it is load-bearing — putting it here would imply Cortex might be guessing about its own event log.

The taxonomy is guarded by a test (`tests/observations.test.ts`) asserting that no event type name contains `believe`, `prefers`, `learner`, `style`, `trait`, `personality`, `knows`, or `understands`. A future contributor adding `user_prefers_examples` fails CI. This is the boundary made mechanical rather than aspirational.

## 8.2 Event taxonomy

Eleven event types, all of which the product actually generates today. Defined in `lib/observations/types.ts`.

| Category | Event | Actor | `source_type` | Notes |
|---|---|---|---|---|
| `interaction` | `question_asked` | user | `message` | Text stays in `messages`. |
| | `answer_generated` | cortex | `message` | Records model, prompt version, citation count, whether grounding passed, latency. |
| | `answer_failed` | cortex | `conversation` | Stage (`retrieval`/`generation`) + bounded reason. |
| | `evidence_cited` | cortex | `document_chunk` | One per citation. The seed of the evidence layer. |
| `retrieval` | `search_performed` | user | `system` | Query text stored; see §8.4. |
| `document` | `document_uploaded` | user | `document` | |
| | `document_processed` | system | `document` | Chunk count, embedding model, tokens, duration. |
| | `document_processing_failed` | system | `document` | Attempt number and whether a retry follows. |
| | `document_deleted` | user | `document` | Title snapshotted; `source_id` deliberately dangles. |
| `explicit_signal` | `memory_stated` | user | `memory` | The only explicit user-stated signal the product supports. |
| | `memory_archived` | user | `memory` | Explicit rejection. |

**Adding an event type requires no migration.** `event_type` and `source_type` are `TEXT` in Postgres with length CHECKs; the vocabulary lives in the TypeScript registry and is validated at the write boundary by `buildObservationRow`. An enum would have meant `ALTER TYPE` against an append-only table for every taxonomy change. `actor` *is* an enum — three values, genuinely closed.

Category, actor, and source type are **derived from the registry**, never passed by call sites, so instrumentation cannot drift from the taxonomy.

## 8.3 Schema decisions

- **Two clocks.** `occurred_at` (when it happened) and `recorded_at` (when Cortex learned it). Named `recorded_at` rather than the sketched `created_at` so the distinction cannot be misread as a naming accident. They genuinely diverge: every request-path observation is written after the response.
- **`source_id` is not a foreign key.** "You uploaded this document on Tuesday" stays true after the document is deleted, and a cascade would silently rewrite history. Tested directly.
- **Append-only enforced twice.** No UPDATE policy (so an owner's `UPDATE` matches zero rows), plus a `BEFORE UPDATE` trigger that also binds the service role, which RLS does not. Both layers are tested.
- **DELETE is allowed.** Append-only forbids *rewriting* history, not erasing it. Erasure is a privacy right, so users may delete their own rows and `ON DELETE CASCADE` from `auth.users` clears an account.
- **Payload size is CHECKed at 8 KB** (context at 2 KB). This mechanically enforces "reference, don't duplicate": answer text, chunk content, and document bodies already have a durable home and must be reached through `source_id`. The TypeScript layer mirrors the limit so writers fail loudly in development.
- **`UNIQUE (user_id, dedupe_key)` is non-partial.** NULLs are distinct in Postgres, so events needing no idempotency key simply leave it NULL, while `ON CONFLICT (user_id, dedupe_key)` can still infer the index — which a partial index would prevent.

## 8.4 What is stored versus referenced

One rule, applied consistently:

> **Never duplicate text that already has a durable home. Do snapshot text that would otherwise be lost.**

- Question and answer bodies → **referenced** via `source_id` into `messages`.
- Search query text → **stored**, because a query has no other durable home and recurring questions are a signal this log exists to preserve.
- Document and citation titles → **snapshotted**, because the source may later be deleted and an uninterpretable observation is worse than none. Mirrors the existing `message_citations` pattern.

## 8.5 How this becomes the evidence layer

`evidence_cited` is already the shape M3/M5 need: a durable link from a Cortex output to the exact chunk that supported it. `claim_evidence` joins `user_claims` to `observations` with a `relation` — no change to this table is required.

```
observations  ──► claim_evidence ──► user_claims ──► confidence + provenance
  (M1, built)      (M3)                (M3/M5)
```

## 8.6 Ingestion recovery

`reclaim_stale_ingestion_jobs(stale_after_seconds, batch_size)` returns jobs stuck in `processing` past the staleness window (default 15 min, floored at 60 s) to `retry`, or to `failed` once the attempt budget is spent, and resyncs the owning document **in the same transaction** so the two can never disagree.

- The attempt budget is **not** re-charged on reclaim — `claim_ingestion_jobs` already charged one at lock time — so a repeatedly crashing job still terminates.
- `FOR UPDATE SKIP LOCKED` means concurrent reclaim passes cannot take the same row.
- Service role only; an authenticated caller gets `permission denied` (tested).
- Workers hold a fencing token (`locked_by` + `locked_at`) and may only release a job they still own, so a revived worker cannot overwrite the run that replaced it.

The reclaim runs at the top of every `processQueuedIngestionJobs` pass, which means the existing 2-minute cron is now also the recovery cycle.

## 8.7 Deviations from the Part 2 proposal

| Proposed | Built | Why |
|---|---|---|
| `subject_type` / `subject_id` | `source_type` / `source_id` | Matches the milestone brief's naming; identical semantics. |
| `source_kind` enum on observations | Omitted | Every M1 observation is by construction observed, never inferred. The distinction belongs to the evidence layer, where it does work. |
| `confidence` on observations | Omitted | Same reason: an event log has nothing to be uncertain about. |
| `actor` as one of several enums | Only enum in the table | `event_type`/`source_type` must be extensible without migrations. |

## 8.8 Not implemented, on purpose

No concepts, no claims, no knowledge states, no interventions, no notices, no inference of any kind, and no UI. Nothing in the product surfaces observations to the user yet — the inspection UI arrives with M3, alongside the first claims, so that "Cortex stores something about you" and "you can see and correct it" ship together and never diverge.

---

# Part 9 — Milestone 2 as built

Shipped: the concept layer — canonical concepts, source-grounded mentions, and evidence-counted edges, extracted inside the existing ingestion worker.

## 9.1 The three rules this schema encodes

1. **No concept without a mention.** A concept with no source span is an unfalsifiable assertion. Enforced by `rebuild_concept_projections`, which prunes orphans on every write path, and asserted by tests after re-ingest, document deletion, and partial re-extraction.
2. **Every mention is verifiable against stored text.** Offsets index `document_chunks.content`, so `substring(content FROM char_start + 1 FOR char_end - char_start) = surface_form` must hold. That is a SQL-checkable invariant, and there is a test that runs exactly that query.
3. **Edges are counted evidence, never asserted relations.** The only relation produced is `co_occurs_with`, whose `evidence_count` is the number of distinct chunks containing both concepts.

## 9.2 Schema

```
concepts         (id, user_id, label, canonical_key, embedding, embedding_model,
                  mention_count, document_count, first_seen_at, last_seen_at)
                 UNIQUE (user_id, canonical_key)      ← the anti-duplicate guarantee

concept_mentions (id, user_id, concept_id, document_id, chunk_id, surface_form,
                  char_start, char_end, page_start, page_end, created_at)
                 UNIQUE (chunk_id, concept_id, char_start)

concept_edges    (id, user_id, from_concept_id, to_concept_id, relation,
                  evidence_count, document_count, updated_at)
                 CHECK (from_concept_id < to_concept_id)   ← undirected, stored once
                 UNIQUE (from_concept_id, to_concept_id, relation)
```

Plus `document_concepts`, a `security_invoker` view for the UI. Without `security_invoker` a view runs with its owner's rights and would bypass the base tables' RLS entirely.

## 9.3 Why offsets are chunk-relative, not document-absolute

The proposal in §2.5 implied offsets into the source document. That cannot be verified: the chunker prefixes each chunk with an overlap carry, so `content` is not `document_text[char_start..char_end]`, and the raw document text is never stored — only the file in Storage and the derived chunks.

Chunk-relative offsets are exactly checkable against a row that does exist. This is the one place where the built schema knowingly diverges from the proposal, and it trades a coordinate space nobody can validate for one the database itself can.

## 9.4 Extraction is untrusted by construction

Extraction uses an LLM with Structured Outputs, not keyword scoring — a keyword extractor cannot tell a concept the passage is *about* from a term that merely appears. But nothing the model returns is believed:

```
model output → normalizeConceptLabel  → drops values, junk, structural terms
             → locate surfaceForm     → drops anything not literally in that chunk
             → group by canonicalKey  → one concept per idea
             → cap                    → bounded concepts/document, mentions/concept
```

The locate step is the guarantee. A hallucinated term, a paraphrased quote, or a mention attributed to the wrong chunk all fail to locate and are dropped, with the count reported as `rejectedMentions`. `groundConceptCandidates` is pure and deterministic, so this is unit-tested without touching a provider.

The stored `surface_form` is sliced from the chunk, not copied from the model's echo, so a model that lowercases or reformats what it quotes cannot corrupt the span.

## 9.5 Deduplication: two layers, deliberately asymmetric

| Layer | Mechanism | Failure mode |
|---|---|---|
| 1. Canonical key | Deterministic normalisation → `UNIQUE (user_id, canonical_key)` | None; it is a hard constraint |
| 2. Embedding neighbour | Cosine ≥ 0.95 against existing concepts | Missed merge (a duplicate row) |

Layer 2 only ever attaches a **new** surface form to an **existing** concept. It never merges two existing concepts. That asymmetry is the point: a threshold set too strict costs a duplicate row that can be merged later, while one set too loose destroys a distinction that cannot be recovered. Exact key always wins over any nearer embedding — tested.

Normalisation deliberately does no stemming. Naive suffix stripping turns "bias" into "bia" and "analysis" into "analysi", inventing collisions between unrelated ideas; the occasional singular/plural split is the cheaper error, and layer 2 catches most of it.

## 9.6 Why concept identity must survive re-ingest

`sync_document_concepts` replaces a document's mentions wholesale but never deletes concept rows mid-sync, pruning orphans only at the end. If concepts were deleted first and recreated, a re-ingest would mint a new id for the same idea — and M3 claims, M4 knowledge states, and M6 notices will all hold concept ids as foreign keys. Stable identity across re-ingest is tested directly.

The same reasoning is why orphan pruning is an explicit step rather than a trigger on `concept_mentions`: a trigger would fire mid-sync, between the delete and the insert, and destroy exactly that identity.

## 9.7 Edges are a full recompute

`rebuild_concept_projections` deletes and recomputes a user's edges from `concept_mentions` on every sync. Incremental counting is not idempotent under re-ingest — a re-processed document would double its own evidence. A personal knowledge base is small enough that provable correctness is worth more than the saved work; tested by re-syncing and asserting the count did not move.

## 9.8 Failure isolation

The concept stage runs after chunks are stored and before the job is released, so the worker ownership fence still protects it — but it is wrapped so it can never throw. Search and Ask depend on chunks and embeddings, not on the graph, so a concept failure records `concept_extraction_failed` and the document still reaches `ready`.

Documents are capped at 240 analysed chunks as a cost and latency circuit-breaker, since extraction holds the job lock and the staleness window is 15 minutes. Truncation is reported as `chunksSkipped`, never silent.

## 9.9 Deviations from the Part 2 proposal

| Proposed | Built | Why |
|---|---|---|
| `char_start`/`char_end` into the document | Offsets into `document_chunks.content` | The only coordinate space that can be verified against stored data. |
| `concept_mentions.observation_id` | Omitted | Mentions are derived state and rebuildable; observations are immutable. A foreign key between them would make an append-only row depend on something that legitimately disappears. |
| `concept_edges.weight` | `evidence_count` + `document_count` | "Weight" invites a model-assigned score. These are counts of chunks and documents, and mean exactly what they say. |
| A `concept_encountered` observation per concept | One `concepts_extracted` per document, carrying the canonical keys | Per-mention events would duplicate rebuildable data into the append-only log. The key list still survives document deletion, which is the part that could not be recovered. |

## 9.10 Tier 1 corrections (post-M2 audit)

An audit of M1 and M2 against this document found three defects in the concept
layer worth correcting before M3 depends on them. Migration
`20260810140000_concept_encounter_time.sql`.

**Encounter time.** `first_seen_at` / `last_seen_at` were derived from
`concept_mentions.created_at`, and `sync_document_concepts` replaces a document's
mentions on every run — so `last_seen_at` tracked "last reprocessed" and a bulk
re-ingest flattened every concept's recency to one moment. That is exactly the
signal M4 and M6 are built on, and the corruption was silent and unrecoverable.

Mentions now carry `encountered_at`, taken from `documents.created_at` *inside*
the function so a caller cannot supply a wrong value. Projections aggregate over
it and are assigned directly rather than folded with `LEAST`/`GREATEST`, so a
rebuild repairs old drift instead of preserving it. `created_at` remains an audit
clock — the same two-clock discipline as `observations`.

**Concept encounters are now immutable evidence.** §9.9 recorded only a
per-document `concepts_extracted` summary, arguing per-concept events would
duplicate rebuildable data. That was wrong: `claim_evidence` joins claims to
*observations*, and concept encounters lived only in `concept_mentions`, which is
derived and cascades away with its document. A JSON array in a payload is not a
joinable evidence target, so concept-grounded claims — most of what M4 and M5
will produce — had nothing durable to point at.

`concept_encountered` is now emitted, one per concept per document, written in
SQL inside `sync_document_concepts` so it is atomic with the mentions it
summarises; emitting it from application code would risk losing an encounter to a
crash between the two writes. `occurred_at` is the document's encounter time, and
the dedupe key uses the **canonical key rather than the concept id**, so a
pruned-and-recreated concept cannot emit a second encounter for material met
once. The TypeScript taxonomy still owns the vocabulary, pinned by a
shape-conformance test.

**Approximate index removed.** The HNSW index on `concepts.embedding` is global,
and an approximate scan under a `user_id` post-filter can discard a user's true
nearest neighbour, silently creating a duplicate.

Measured with `EXPLAIN`, the planner was **not** choosing that index: it filters
on `user_id` first and sorts the small remainder, so the lookup was already
exact. The audit overstated this one — it was a latent planner cliff, not an
active bug. The index is dropped anyway, because the cliff is real, data
dependent, and invisible until it bites, while an exact scan over a few hundred
per-user concepts costs nothing. A partial btree on `(user_id) WHERE embedding IS
NOT NULL` keeps that scan tenant-scoped. Do not reintroduce an ANN index without
per-user partitioning or a validated iterative scan.

Two integrity fixes shipped alongside: a concept created without an embedding is
now backfilled when a later run supplies one (previously it stayed permanently
invisible to deduplication with no way to identify affected rows), and
`sync_document_concepts` pre-validates that every referenced chunk belongs to the
target document, closing an unenforced cross-tenant invariant in a
`SECURITY DEFINER` function.

## 9.11 Not implemented, on purpose

No typed semantic relations (`is_a`, `part_of`, `causes`) — there is no grounding method for them, and an LLM-asserted ontology is precisely the "unsupported semantic relationship" this layer exists to avoid. The `relation` column exists so they can be added when there is one.

No knowledge states, no mastery, no claims, no notices, no cross-document connection surfacing. The UI addition is a read-only list of concept chips per document; span-level highlighting arrives with the M3 inspection surface.

---

# Part 10 — Milestone 3 as built

Shipped: explicit, evidence-backed claims about what the user has said they think, want, believe, care about, or are trying to understand. **No inference.**

## 10.1 The epistemic boundary, mechanically

Three levels, and M3 implements only the first two:

| | Recorded as | Example |
|---|---|---|
| Observation | `claim_stated` | The user wrote "I think retrieval is becoming less important" at span [12,58] of message M |
| Explicit claim | `user_claims` (`asserted_by='user'`) | User thinks retrieval is becoming less important than synthesis |
| **Inference** | **not implemented** | Cortex suspects the user's thinking has shifted |

The boundary is not delegated to a prompt. Two pure, unit-tested guards run on every candidate in `lib/claims/grounding.ts`:

- **Stance guard** — the sentence containing the excerpt must carry an explicit first-person stance marker (`I think`, `I want`, `I'm trying to`, `in my view`, …). A bare fact ("Transformers are used in ChatGPT") and an information-seeking question both fail it. "I" alone is deliberately not enough, because "I read that X" is also first person.
- **Reported-speech guard** — the sentence must not be relaying a source (`I read`, `according to`, `the paper argues`, `they say`). This runs *before* the stance guard, because "I read a paper arguing X" satisfies both, and disentangling "read and agreed" from "read" is exactly the judgement this layer must not make on the user's behalf.

Together they enforce the rule the milestone turns on: **encountering an idea is not holding it.** A test asserts no claim type name matches `/personality|learning.style|trait|disorder|adhd|depress|diagnos|…/`.

## 10.2 Taxonomy

`belief · goal · interest · preference · open_question · hypothesis · self_description`, plus `note`.

`position` from the original sketch was dropped: in practice it is indistinguishable from `belief`, and a category that forces an arbitrary choice produces noise rather than structure.

`note` is **migration-only** and cannot be produced by extraction. It is where legacy `memories` land, because assigning them a real category would require guessing — which is an inference.

## 10.3 Evidence model

```
user message → claim_stated observation → user_claims
                        ↑                      │
                        └──── claim_evidence ──┘
```

`claim_evidence` carries `observation_id`, `relation` (`originates`/`supports`/`contradicts`), the grounding span (`source_message_id`, `char_start`, `char_end`, `excerpt`), and `occurred_at`. The span columns are nullable so a future inferred claim can cite a measured outcome that has no text span, reusing the same table.

Two invariants, both enforced by the database rather than by convention:

- **No claim without evidence** — a `DEFERRABLE INITIALLY DEFERRED` constraint trigger rejects any claim reaching commit with none. Deferral is what lets the claim and its evidence be written in one transaction while still being checked before commit.
- **No dangling evidence** — `observation_id` is `ON DELETE CASCADE`, and a single statement-level trigger refreshes `evidence_count` and then deletes claims left with zero. Counting and pruning are one function on purpose: their order matters, and relying on Postgres firing triggers in name order would let a rename silently change behaviour.

## 10.4 Deletion semantics

Deleting an observation cascades its evidence, and if it was the last, the claim goes with it.

Chosen over *mark unsupported* (a standing claim with no evidence is exactly the failure mode this architecture exists to prevent) and over *prevent deletion* (M1 deliberately granted erasure). Deleting a claim leaves its `claim_stated` observation intact: the record of what was said survives the removal of Cortex's interpretation of it, which is the correct asymmetry.

## 10.5 Temporal model

`valid_from` is when the user said it — taken from `messages.created_at`, never row-write time. Restating a claim **adds evidence**: `last_stated_at` advances, `evidence_count` rises, and the statement is never rewritten. A *different* statement is always a new claim; there is no auto-supersession and no contradiction engine, so a user who changes their mind ends up with both claims active and Cortex does not decide which is true.

Retract and archive set `status` and `valid_to` and leave the statement and its evidence untouched — a `CHECK` requires anything non-active to record when it stopped. `superseded_by` exists for later revision work. The inspection UI shows closed claims under "No longer held", because that the user changed their mind is itself the valuable record.

## 10.6 Deduplication

Deterministic canonical key only, unique per `(user_id, claim_type, canonical_key)`. No stemming and no stop-word removal — both would risk collapsing "I think X" with "I no longer think X", which a test pins directly.

Embeddings are stored on `user_claims` for future revision and contradiction work but are **deliberately not used for identity** in M3. A duplicate claim is visible and mergeable later; an incorrect merge destroys a distinction the user actually drew, and there is no way to recover it.

## 10.7 Identity continuity with `memories`

`memories` is kept, not deleted. `sync_memory_claim` finds or creates the `memory_stated` observation (memories predating M1 have none, and a claim without evidence cannot exist), maps the memory to a `note` claim dated to the memory's own `created_at`, and records `user_claims.source_memory_id` as an explicit mapping. Adding a memory now mirrors into a claim, and archiving one archives the claim, so the two models cannot diverge while both exist.

## 10.8 Security

Claims are read-only to the client: `SELECT` and `DELETE` policies only, with every write behind a `SECURITY DEFINER` function, so a statement cannot be forged or rewritten. `record_user_claims` and `close_user_claim` derive the owner from `auth.uid()` rather than a parameter — a definer function that trusts a caller-supplied user id can be pointed at anyone. `sync_memory_claim` rejects a memory belonging to someone else. All four properties are tested, including that account deletion removes the whole model.

## 10.9 Not implemented, on purpose

No inferred claims, no personality or learning-style modelling, no diagnosis, no belief inference from reading, no contradiction detection, no proactive agent, no learner or retention model. `asserted_by='cortex'` is reserved and never written.

---

# Part 11 — Milestone 4 as built

Shipped: `knowledge_states`, a per-concept projection of counts and timestamps already present in the observation log, plus a column-privilege fix on `documents`.

## 11.1 The `documents` write-surface fix

The open audit item was described as a cross-user `UPDATE` hole. Measured, it was not: the shipped policy carries both `USING` and `WITH CHECK` on `auth.uid() = user_id`, so another user's row is untouchable and ownership cannot be reassigned.

The real gap was **column-level and self-inflicted**. A document's owner could set `status = 'ready'` on something that never ingested, clear a genuine `extraction_error`, or rewrite `processed_at`, `content_hash`, `embedding_model`, and `file_path` — all derived state whose only legitimate writer is the service-role worker.

RLS is the wrong tool: a policy's `WITH CHECK` cannot see the old row, so it cannot express "you may not change this column". The fix is column privilege — `REVOKE UPDATE … FROM authenticated`, then `GRANT UPDATE (title)`. The row policy is untouched.

## 11.2 Schema

```
knowledge_states  PRIMARY KEY (user_id, concept_id)
├── encounter_count, encounter_document_count
├── first_encountered_at, last_encountered_at
├── retrieval_count, retrieval_answer_count
├── first_retrieved_at, last_retrieved_at
└── derived_through_observation_id
```

Every column is a `COUNT`, `MIN`, or `MAX` over `observations`. There is **no `rebuilt_at`** — deliberately. A wall clock in the row would change on every rebuild and make the purity claim untestable; a test asserts the column is absent.

## 11.3 What it reads

Two event types, no new instrumentation:

- `concept_encountered` → joined to concepts **by canonical key, not `source_id`**. A concept pruned and recreated gets a new row id while the key is its durable identity, so joining on the id would silently drop the history of an idea the user met before a re-ingest. Tested.
- `evidence_cited` → `source_id` (chunk) → `concept_mentions` → concept. `DISTINCT` on the observation, so one citation of a chunk mentioning a concept three times is one retrieval.

`retrieval_count` counts citations; `retrieval_answer_count` counts distinct answers, so one answer citing four passages of the same idea is four retrievals but one answer.

## 11.4 Purity

`rebuild_knowledge_states(user_id)` is `DELETE` + one `INSERT … SELECT`. The acceptance test truncates the table, rebuilds, and asserts `SELECT *` is byte-identical — including `derived_through_observation_id`, which is deterministic because it picks the newest contributing observation by `(occurred_at, id)`.

It is folded into `rebuild_concept_projections` rather than called separately: that function already means "recompute every derived concept projection for this user", so both existing callers (`sync_document_concepts`, `prune_orphan_concepts`) pick it up unchanged, and there remains exactly one place where derived concept state is produced. The Ask route refreshes it after an answer, but only when that answer actually cited evidence.

The table is read-only to clients twice over: RLS grants `SELECT` only, and `INSERT`/`UPDATE`/`DELETE` are revoked outright, so a client cannot write even a row it owns.

## 11.5 Accepted limitation (an M5 consideration)

`concept_mentions` is derived state that cascades away with its document. Retrievals attributed to a document the user later deleted therefore cannot be reconstructed: the `evidence_cited` observation survives, but the chunk→concept link that resolved it does not.

So precisely: **the rebuild is exactly reproducible from currently retained data, which is what the purity test asserts. It is not a reconstruction of all history.** A test pins this behaviour explicitly so the limitation is visible rather than surprising.

Closing it would mean recording concept ids on `evidence_cited` at write time — new instrumentation, deliberately out of scope here, and carried into the M5 discussion.

## 11.6 Not implemented, on purpose

No mastery, confidence, familiarity, or strength score. No forgetting curve, half-life, or decay. No retrieval *success* signal — nothing in the log distinguishes a citation that helped from one that did not, and inferring it would be exactly the unsupported step this architecture exists to prevent. A test asserts the table's column names match none of `mastery|confidence|score|strength|familiar|decay|half_life|retention|forget|proficien|level`, and pins the exact column set.

The UI addition is a read-only counts table on the existing `/dashboard/model` page, deliberately not presented as a ranking of how well anything is known.


---

# Part 12 — Milestone 5 as built

Shipped: citation-level concept attribution, and the first claims Cortex asserts itself.

## 12.1 Closing the retrieval-attribution gap

`evidence_cited` now carries `conceptIds` **and** `conceptKeys`, captured at citation time by `attachConceptAttribution` while the mentions still exist. Keys as well as ids because the Tier 1 audit established the canonical key as a concept's durable identity — a pruned-and-recreated concept gets a new row id.

`rebuild_knowledge_states` resolves through three branches: by key, by id, and by chunk join **only for unattributed citations**. `UNION`, not `UNION ALL`, so one citation resolving via both lists is still one retrieval. Nothing is backfilled — a payload cannot be reconstructed for a citation whose document is already gone. Purity is unchanged.

## 12.2 What M5 reuses

`user_claims` and `claim_evidence` are reused in shape. M3 reserved `asserted_by='cortex'`, left `confidence`/`confidence_method` writable, and made the evidence span columns nullable for exactly this. Added: `inference_rule`, `inference_min_evidence`, a `claim_rejections` table, and the `unsupported` status.

## 12.3 The one rule

`sustained_interest` — the user has repeatedly and independently stated interest in, goals concerning, or questions about the same concept. It is a **synthesis of explicit claims**, never a latent attribute: the statement is about what the user said, and every occasion is cited.

Bar, all required: ≥3 distinct user claims, across ≥3 distinct messages, conversations, **and** calendar days, spanning ≥14 days, with no contradicting user claim. Only `claim_stated` observations are read, so document content can never contribute — the M3 boundary holds automatically.

`confidence_method` is a built sentence, e.g. `3 independent explicit claims naming "working memory" across 3 conversations over 30 days; no contradicting claim`. Confidence is a published function of counts, capped below certainty.

## 12.4 Concept matching: exact, no stemming

Whole-phrase containment against the concept's canonical key **or** any surface form M2 recorded for it. No stemming: "transformers" does not match "transformer". Surface forms are what let "ADHD" reach a concept labelled with the expanded name — and they mean the inference **inherits M2's extraction accuracy**, which a test pins explicitly. Expect this to fire sparsely on a young corpus. Under-matching is the intended direction of error.

## 12.5 Evidence removal re-evaluates the inference

An inferred claim that falls below `inference_min_evidence` is automatically set to `unsupported` with `valid_to`. It does not wait for the user to notice.

Two distinct withdrawals:
- **`unsupported`** — automatic, evidence-driven, **reversible**: returning evidence reactivates it.
- **user rejection** — permanent, recorded in `claim_rejections`, skipped by every later pass.

A user claim is deliberately unaffected: one statement suffices for it, so losing a restatement changes nothing.

## 12.6 Rejection outranks re-inference

`claim_rejections` is keyed on `(user_id, claim_type, canonical_key)` — **not claim id**. Keying on the id would let deleting the claim erase the refusal and the next pass recreate it; a test deletes the claim and asserts the refusal survives. Restoring the claim withdraws the refusal.

## 12.7 Where the boundary is soft

Named rather than hidden:

1. **Concept matching is lexical.** A claim discussing a concept without naming it is invisible. Failure mode is under-inference.
2. **Contradiction detection is lexical.** Retraction and explicit reversals are caught; semantic contradiction is not. Survivable only because the inference is weak enough to stay literally true — "you have repeatedly said this" — and the date range is shown.
3. **Independence is a structural proxy.** Three conversations on three days does not prove independence of thought. Named in `confidence_method` so the user judges it.
4. **Goals can be complete.** No completion signal exists, so an inference can be stale-but-true.
5. **Inference inherits M2.** A wrongly attributed surface form pulls the inference with it.

## 12.8 Not implemented, on purpose

No personality, learning-style, or psychological inference. No mastery or forgetting score — the M4 outcome-signal problem is unsolved and this milestone does not solve it. No inference from a single observation, from one sitting, or from document content. No autonomous surfacing: nothing notifies the user, and `/dashboard/model` shows inferences only when visited.


---

# Part 13 — Milestone 6 as built

Shipped: proactive notices, with the response loop built before the detectors.

## 13.1 Why the loop came first

Every detector in the original design is a query over projections that already
exist — the engineering is easy. What cannot be added later is the **response**:
a dismissal is the only honest signal that Cortex was wrong to raise something,
and like every other signal here, an interaction that was never recorded is gone.
So the loop was built first and the detectors kept deliberately few.

## 13.2 Schema

```
notices  UNIQUE (user_id, kind, subject_key)
├── kind, subject_key        -- subject_key from CANONICAL KEYS, never row ids
├── payload                  -- snapshot of the counts behind it
├── confidence_method        -- inspectable sentence, never a score
├── detected_at, surfaced_at
└── response, responded_at   -- pending | accepted | dismissed
```

That unique constraint **is** the suppression mechanism; there is no separate
rejection table. Building `subject_key` from canonical keys rather than concept
ids is what makes a dismissal survive the concept graph being wiped and rebuilt —
tested directly by deleting every document, pruning, and re-ingesting.

## 13.3 The loop

Three observations close it: `notice_surfaced`, `notice_accepted`,
`notice_dismissed`.

Surfacing is recorded **separately from detection**, because they are different
facts. A notice can sit detected for days before anyone opens the page, and
without both timestamps a dismissal rate is uninterpretable — you cannot tell
"shown and rejected" from "never seen". Responding also backfills `surfaced_at`,
since answering implies having seen it.

## 13.4 Detectors

| Kind | Fires when |
|---|---|
| `concept_connection` | two concepts share ≥3 passages across ≥2 distinct documents |
| `recurring_concept` | one concept appears in ≥3 distinct documents spanning ≥30 days |

Both render as counted statements — *"'working memory' and 'ADHD' appear together
in 4 passages across 2 of your documents"*. The notice **is** its own evidence.

There is deliberately **no `knowledge_gap` detector**. "You keep meeting X but
don't know it" is exactly the mastery inference Milestone 4 ruled out, and
nothing in the log distinguishes a citation that helped from one that did not. A
test asserts no notice kind or method string matches
`gap|mastery|weak|struggl|forget|rusty|should learn|proficien`.

## 13.5 Cold start

Handled by the thresholds themselves, not a ship date. A thin corpus produces
silence rather than noise — tested explicitly with a single document.

## 13.6 When detection runs

Where the evidence changes, not when the page is viewed: after concept sync in
the ingestion worker, and after claims change in the Ask route. A Server
Component render should not mutate, and a notice should already exist by the
time anyone looks. The page only reads, and records surfacing via `after()`.

Counts refresh on a **pending** notice — stale numbers on something nobody has
seen help nobody — but never on one already answered.

## 13.7 Not implemented, on purpose

No autonomous surfacing of any kind: no push, no email, no notification. Notices
appear only on `/dashboard/model` when the user opens it. No contradiction
detector — that needs the semantic comparison M5 explicitly could not do. No
mastery or forgetting signal. No intervention ledger.
