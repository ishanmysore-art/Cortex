# Cortex — Version 1 Roadmap

> An AI operating system for your thinking. Built incrementally over four years.

## Architecture (V1)

```
Browser (Next.js App Router)
    │
    ├── Server Components — pages, layouts, data fetching
    ├── Client Components — uploads, chat streaming, interactivity
    └── Route Handlers — API endpoints (search, chat, upload)
            │
            ├── Supabase Auth — sessions, RLS
            ├── Supabase Postgres — documents, chunks, metadata
            ├── pgvector — semantic search
            └── OpenAI — embeddings + chat completions
```

**Why this stack?** One codebase, one database, minimal DevOps. Supabase gives you auth + Postgres + storage in one place. pgvector keeps vectors next to your data — no separate vector DB to manage until you outgrow it (likely years away).

---

## Milestones

### Milestone 1 — Foundation & Design System ✅
- Project folder structure
- Design tokens (typography, color, spacing)
- Landing page with Cortex identity
- Reusable UI primitives (`Button`, `Header`)
- `.env.example` for future services

**You learn:** Next.js App Router conventions, component architecture, design systems.

---

### Milestone 2 — Authentication ✅
- Supabase project setup
- Email/password sign up & sign in
- Session management with `@supabase/ssr`
- Middleware to protect routes
- Auth pages: `/login`, `/signup`

**You learn:** Server-side auth, cookies vs JWT, Row Level Security basics.

---

### Milestone 3 — Dashboard Shell ✅
- Protected `/dashboard` layout
- Sidebar navigation (Notes, Search, Ask)
- Empty states with clear CTAs
- Sign out flow

**You learn:** Route groups, nested layouts, server-side session checks.

---

### Milestone 4 — Document Upload ✅
- Upload markdown, `.txt`, and PDF files
- Store raw files in Supabase Storage
- Document metadata in Postgres (`documents` table)
- Document list view with status indicators

**You learn:** File uploads, Supabase Storage, database schema design.

---

### Milestone 5 — Chunking & Embeddings ✅
- Extract text from uploaded files (PDF parsing)
- Split documents into overlapping chunks
- Generate embeddings via OpenAI `text-embedding-3-small`
- Store chunks + vectors in Postgres with pgvector

**You learn:** RAG fundamentals, chunking strategies, embedding models, vector dimensions.

---

### Milestone 6 — Semantic Search ✅
- Search bar on dashboard
- Query embedding → cosine similarity via pgvector
- Ranked results with snippet previews
- Link results back to source documents

**You learn:** Vector similarity search, SQL with pgvector, search UX patterns.

---

### Milestone 7 — Production-ready Ask & Memory Foundation ✅
- Durable, retryable document ingestion jobs
- Validated uploads, per-user request limits, security headers, and usage telemetry
- Chat interface on `/dashboard/ask` with persisted conversations and streaming Responses API answers
- Grounded retrieval with source snapshots, page-aware citations, and prompt-cache metrics
- Explicit user-managed durable memory, separate from conversation history

**You learn:** Retrieval-Augmented Generation, streaming SSE, prompt engineering, citation formatting.

---

### Milestone 8 — Polish & Deploy ✅
- Error handling and loading states
- Mobile-responsive layout pass
- Deploy to Vercel + Supabase production
- Basic monitoring

**You learn:** Production deployment, environment management, observability basics.

---

## Version 2 — the personal cognitive model

V1 is a knowledge base: it remembers what you read. V2 is a longitudinal,
evidence-backed model of how you think. Full design in
[docs/cortex-v2-architecture.md](docs/cortex-v2-architecture.md).

### V2 Milestone 1 — Observation & Evidence Spine ✅
- `reclaim_stale_ingestion_jobs` recovers ingestion runs abandoned by a crashed worker
- Worker fencing token (`locked_by` + `locked_at`) prevents a revived worker overwriting its replacement
- `observations`: append-only, user-scoped, bitemporal, provenance-aware event log
- Typed event taxonomy and internal API in `lib/observations/`
- Instrumented: ask, search, upload, ingestion outcome, memory add/remove
- Database-level tests for RLS isolation, append-only enforcement, idempotency, and crash recovery

**Why first:** it is the only component that cannot be backfilled. Documents can be
re-ingested and embeddings recomputed, but an interaction that was never recorded
is gone permanently.

**Deliberately not built:** concepts, claims, inference, personalization, UI.

### V2 Milestone 2 — Concept layer ✅
- `concepts`, `concept_mentions`, `concept_edges` + a `security_invoker` view for the UI
- LLM extraction verified against source text: a concept survives only if its surface
  form is literally found in the chunk it was attributed to
- Two-layer deduplication — a deterministic canonical key (hard unique constraint)
  plus a conservative embedding neighbour that only ever adds a surface form to an
  existing concept, never merges two
- Edges are counted co-occurrence, never asserted semantic relations
- Concept identity stays stable across re-ingest, so later layers can hold concept ids
- Non-fatal: extraction failure never keeps a document out of the knowledge base
- Concept chips per document on the Notes page

**Why this next:** concepts are the join key between what the user has read and what
later milestones model about them. M4 and M6 are both blocked without them.

**Deliberately not built:** typed semantic relations, knowledge states, claims,
proactive surfacing.

### V2 Tier 1 corrections ✅
Post-M2 audit fixes, landed before M3 could depend on them:
- Concept timestamps anchored to when the user encountered the material, stable
  across re-ingest (was silently tracking "last reprocessed")
- Immutable `concept_encountered` observations — the durable evidence future
  claims point at, since `concept_mentions` cascades away with its document
- Approximate index on `concepts.embedding` removed so tenant-scoped
  deduplication can never be defeated by a future planner choice
- Embedding backfill on match; chunk-ownership validation in `sync_document_concepts`

### V2 Milestone 3 — Explicit claims & evidence ✅
- `user_claims` + `claim_evidence`, with a new `claim_stated` observation as the
  immutable evidence every claim points at
- Taxonomy: belief, goal, interest, preference, open_question, hypothesis,
  self_description (+ `note`, migration-only for legacy memories)
- Two deterministic guards enforce the epistemic boundary: an explicit
  first-person stance marker is required, and reported speech is rejected — so
  "I read a paper arguing X" can never become "the user believes X"
- Database-enforced invariants: no claim without evidence (deferred constraint
  trigger), no dangling evidence (cascade + prune)
- Temporal: restating adds evidence, never overwrites; a different statement is
  always a new claim; retract/archive preserve the wording and its evidence
- Legacy `memories` mapped to claims with explicit `source_memory_id` continuity;
  the old table is kept until the replacement is proven
- `/dashboard/model` — see every claim, its evidence, and remove what is wrong

**Deliberately not built:** any inference. `asserted_by='cortex'` is reserved and
never written. No personality, learning style, diagnosis, or contradiction engine.

### V2 Milestone 4 — Knowledge states ✅
- `documents` column-privilege fix: an owner could forge their own document's
  ingestion state (`status`, `extraction_error`, and other derived columns).
  Cross-user updates were already blocked; the gap was column-level.
- `knowledge_states`: per-concept counts and timestamps derived from
  `concept_encountered` and `evidence_cited`. No new instrumentation.
- Purity is the defining property — `TRUNCATE` + rebuild reproduces byte-identical
  state, asserted directly. No `rebuilt_at` column, because a wall clock would
  make that untestable.
- Read-only to clients twice over: `SELECT`-only RLS plus revoked write privileges.
- Counts table on `/dashboard/model`, explicitly not a ranking.

**Deliberately not built:** mastery, confidence, familiarity, forgetting curves,
or any retrieval-success signal. A test pins the column set so none can creep in.

**Accepted limitation:** retrievals attributed to a since-deleted document cannot
be reconstructed, because the chunk→concept link lives in derived state. The
rebuild is exact over retained data, not over all history. See M5.

### V2 Milestone 5 — Evidence-backed inference ✅
- `evidence_cited` now carries concept ids and keys at write time, so retrieval
  attribution survives document deletion. Pre-existing observations keep the
  weaker chunk-join path; nothing is backfilled.
- First `asserted_by='cortex'` claims, reusing `user_claims`/`claim_evidence`
  unchanged in shape
- One rule, `sustained_interest`: ≥3 distinct user claims across ≥3 messages,
  conversations and days, spanning ≥14 days, no contradicting claim
- `confidence_method` is an inspectable sentence built from the evidence, not a score
- Evidence removal automatically withdraws an inference below its own bar
  (`unsupported`, reversible); a user rejection is permanent and keyed on
  canonical key so deleting the claim cannot erase it
- Inferred claims shown distinctly on `/dashboard/model` with reasoning and a reject action

**Deliberately not built:** personality, learning-style, or psychological inference;
mastery/forgetting; inference from one observation, one sitting, or document
content; autonomous surfacing.

### V2 Milestone 6 — Proactive notices ✅
- Response loop built **before** the detectors: `notice_surfaced`,
  `notice_accepted`, `notice_dismissed` observations. A dismissal is the only
  honest signal that Cortex was wrong, and it cannot be backfilled.
- `notices`, with suppression as a `UNIQUE (user_id, kind, subject_key)`
  constraint rather than a separate table. Subject keys come from canonical keys,
  so a dismissal survives the concept graph being wiped and rebuilt.
- Two conservative detectors, both pure counts: `concept_connection` (≥3 shared
  passages across ≥2 documents) and `recurring_concept` (≥3 documents over
  ≥30 days).
- Surfacing recorded separately from detection, so a dismissal rate is interpretable.
- Detection runs where evidence changes, not on page render.

**Deliberately not built:** any autonomous surfacing (no push, email, or
notification); a knowledge-gap detector, which would be the mastery inference M4
ruled out; contradiction detection, which needs semantic comparison M5 could not do.

### V2 Milestone 7 — Intervention ledger (next)
Record what Cortex did and what measurably followed. Recording only — no policy
learning until there is enough data to analyse.

---

## Folder Structure

```
cortex/
├── app/
│   ├── (auth)/               # Login, signup
│   ├── (app)/                # Protected app (dashboard, etc.)
│   ├── api/                  # Route handlers
│   ├── layout.tsx
│   └── globals.css
├── components/
│   ├── ui/                   # Primitives (Button, Input, etc.)
│   └── layout/               # Header, Sidebar, etc.
├── lib/
│   ├── supabase/             # Supabase clients (Milestone 2)
│   ├── openai/               # OpenAI client (Milestone 5)
│   ├── observations/         # Observation spine (V2 Milestone 1)
│   ├── concepts/             # Concept extraction + grounding (V2 Milestone 2)
│   ├── claims/               # Explicit claims + evidence (V2 Milestone 3)
│   ├── knowledge/            # Knowledge-state projection (V2 Milestone 4)
│   ├── notices/              # Proactive notices + response loop (V2 Milestone 6)
│   └── utils.ts
├── types/
│   └── index.ts
└── supabase/
    └── migrations/           # SQL migrations (Milestone 2+)
```
