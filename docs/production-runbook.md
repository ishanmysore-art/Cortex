# Production runbook

## Before deployment

1. Apply each migration under `supabase/migrations/` to the production Supabase project.
2. Run `npm run check:env` with production environment variables available to the command. It fails if the target database is missing any object the build expects, naming the unapplied migration file, and prints the project ref it checked. Expectations are derived from `supabase/migrations/`, so the check covers every milestone automatically. Run locally with no arguments and it falls back to `.env.local`.
3. Confirm the Supabase Auth redirect URL includes `https://<domain>/auth/callback`.
4. Set `CRON_SECRET` (or `INTERNAL_WORKER_SECRET`) and `SUPABASE_SERVICE_ROLE_KEY` in the deployment environment.
5. Deploy. Vercel invokes `/api/internal/ingestion` every two minutes through `vercel.json`.

## Release checks

- `GET /api/health` should return `200` and `{ "status": "ok" }`.
- Upload a small text file, then confirm it reaches `ready` after a worker cycle.
- Search the document and ask a question that requires a citation.
- Confirm the generated answer is persisted after a refresh and any saved memory is visible in a new conversation.

## Monitoring

- Monitor `/api/health` externally for availability and configuration failures.
- Review Vercel function logs for `Ask stream failed` and `Ingestion worker failed` events.
- Review Supabase logs for RLS, RPC, and cron-related failures.
- Query `ai_usage_events` for OpenAI volume, latency, and prompt-cache token usage.

## Incident response

- **`503 worker_not_configured` from `/api/internal/ingestion`:** neither `CRON_SECRET` nor `INTERNAL_WORKER_SECRET` is set in that environment. Ingestion will never run and stale jobs will never be reclaimed. A `401` from the same endpoint means the secret is set but the caller sent the wrong one.
- **Schema drift after a deploy:** `npm run check:env` names the missing objects. Apply with `supabase db push`; if the project's schema predates its migration history, `supabase migration repair --status applied <version>` the already-present migrations first so push does not replay them.
- **Uploads remain pending:** verify the worker secret, service-role key, migration state, and cron invocation logs. A caller sending no or the wrong Bearer secret gets `401`; an environment where the secret was never set gets `503 worker_not_configured`.
- **A document is stuck in `processing`:** a worker died mid-run. The next worker pass reclaims it automatically once its lock is 15 minutes old; look for `Reclaimed stale ingestion jobs` in the logs. If the cron is not firing, no reclaim happens either — check the cron before touching the job rows by hand.
- **Search returns rate-limit errors:** confirm the production migration contains `consume_rate_limit`, then issue `NOTIFY pgrst, 'reload schema';` in the Supabase SQL editor.
- **Ask responses fail:** check the OpenAI key/model setting and the application log containing the request failure. Conversations and messages remain in Supabase for inspection.
- **Rollback:** deploy the prior application version only after verifying its required schema remains compatible. Do not remove migration-managed tables as a rollback shortcut.
