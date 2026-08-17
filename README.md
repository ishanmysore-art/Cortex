# Cortex

Cortex is a private, AI-assisted knowledge base. Users upload PDFs, Markdown, and text files; Cortex extracts and embeds them for semantic search, then answers questions using grounded, cited RAG conversations.

## Architecture

- Next.js 16 App Router with Server Components, Server Actions, and a streaming Ask Route Handler
- Supabase Auth, Postgres, private Storage, Row Level Security, and pgvector
- OpenAI embeddings (`text-embedding-3-small`) and streaming Responses API generation
- A durable ingestion-job table and protected scheduled worker instead of request-bound parsing

## Local setup

1. Copy `.env.example` to `.env.local` and provide the required values.
2. Apply the SQL migrations in `supabase/migrations/` to the target Supabase project, in order.
3. Run `npm run dev`.

Useful checks:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run check:env
```

`check:env` validates the required environment variables **and** verifies the target database actually carries the schema this build expects, naming the project ref it checked and any unapplied migration file. Run it against any environment before deploying: migration files existing in the repo says nothing about whether they were applied.

The expected objects are derived by parsing `supabase/migrations/` — never listed by hand, so the check cannot fall behind the migrations it is meant to guard. It reads PostgREST's OpenAPI document rather than calling anything, since several of these functions mutate.

It falls back to `.env.local` when a variable is absent from the environment, so it runs locally with no setup; real environment variables always take precedence, so CI and production values are never overridden by a developer's local file.

## Required production configuration

- `SUPABASE_SERVICE_ROLE_KEY` is used only by the protected ingestion worker. Never expose it to browser code.
- Set `CRON_SECRET` (or `INTERNAL_WORKER_SECRET`) to authorize `/api/internal/ingestion`. The included `vercel.json` invokes that endpoint every two minutes on Vercel; another host must schedule the same authenticated request itself. Without the secret the endpoint returns `503 worker_not_configured` and logs an error — deliberately distinct from the `401` an unauthorized caller gets, so a misconfigured deploy is visible rather than looking like routine rejected traffic.
- **Vercel Hobby only permits once-daily crons.** The two-minute schedule in `vercel.json` requires a Pro plan; on Hobby it is silently reduced, and uploads will sit `pending` for up to a day.
- Set a stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` for multi-instance deployments.
- Configure Supabase email redirect URLs for `https://<your-domain>/auth/callback`.
- Review OpenAI data-retention settings and obtain the appropriate user consent before production use. Cortex persists conversations itself and sends `store: false` for generated responses.

## Data ownership and safety

- Documents and Storage objects are scoped to the authenticated user through Supabase RLS.
- Derived chunks preserve source offsets and PDF page ranges for citations.
- Conversations are append-only messages; durable memory is opt-in through the Memory panel and can be removed by the user.
- Ingestion validates type and size (10 MB), runs asynchronously, retries transient failures, and records final error state on the document.
- Ingestion also derives a concept graph. Every concept is grounded in at least one verifiable span of stored chunk text, and concept links record counted co-occurrence rather than asserted relationships. Concept extraction is non-fatal: if it fails, the document still becomes searchable.
- Cortex records explicit claims — things you have actually said you think, want, or are trying to understand — each backed by the exact words you wrote. Nothing is inferred: a claim is only kept when you spoke for yourself, and material you merely read or quoted never becomes a belief. Everything is visible and removable at `/dashboard/model`.
- Cortex tracks how often each idea appears in your material and how often it has been cited when answering you. These are counts and dates derived from the log — never a judgement about how well you know something. Visible at `/dashboard/model`.
- Cortex may also infer a recurring theme — but only from several things you said on separate occasions, weeks apart, never from what you read. Each inference shows its reasoning and every statement behind it, is labelled as inferred rather than stated, and can be rejected permanently.
- Cortex surfaces a few counted patterns in your own material — two ideas that keep appearing together, or one that keeps recurring across documents. They appear only when you open the page; nothing is pushed or emailed. Telling Cortex a notice was not useful removes it permanently. No notice judges what you know.
- Cortex keeps an append-only `observations` log of what happened (questions asked, answers produced, documents added or removed, memories saved). It records events, never conclusions about the user. Rows are RLS-scoped, can never be updated, and are deleted with the account or by the user. See [the V2 architecture](docs/cortex-v2-architecture.md#part-8--milestone-1-as-built).

## Operational notes

- Uploads remain `pending` until the worker claims the job. A missing worker secret/service role configuration will leave uploads pending.
- Every worker pass first calls `reclaim_stale_ingestion_jobs`, returning jobs abandoned for more than 15 minutes to the queue without spending an extra retry attempt. A crashed worker therefore self-heals on the next cycle instead of leaving a document stuck in `processing`.
- Prompt caching is measured through `ai_usage_events`; cache effectiveness depends on a repeated exact prompt prefix and requests of at least 1,024 input tokens.
- The current vector index is appropriate for an early-stage single-region deployment. Track recall and latency before introducing a separate search service or tenant partitioning.
- `GET /api/health` is a public configuration-readiness endpoint suitable for an uptime monitor. See [the production runbook](docs/production-runbook.md) for release checks and incident response.
# Cortex
