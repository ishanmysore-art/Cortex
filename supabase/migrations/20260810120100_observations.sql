-- Milestone 1: the observation spine.
--
-- An append-only record of what actually happened. Observations are never
-- inferences: nothing in this table is a conclusion about the user, only a
-- statement that a specific event occurred at a specific time with a specific
-- source. The evidence and claim layers are built on top of this in later
-- milestones; see docs/cortex-v2-architecture.md.

-- Who caused the event. Genuinely closed set, so an enum is appropriate.
CREATE TYPE observation_actor AS ENUM ('user', 'cortex', 'system');

CREATE TABLE public.observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- `event_type` and `source_type` are TEXT rather than enums on purpose. The
  -- taxonomy is owned by lib/observations/types.ts and validated at the write
  -- boundary, so adding an event type is a code change instead of an
  -- `ALTER TYPE` against an append-only table. The CHECKs bound the storage;
  -- the application owns the vocabulary.
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
  event_category TEXT NOT NULL CHECK (char_length(event_category) BETWEEN 1 AND 32),
  actor observation_actor NOT NULL,

  -- Provenance pointer into an existing source of truth. Deliberately NOT a
  -- foreign key: "you uploaded this document on Tuesday" stays true after the
  -- document is deleted, and the log must not be rewritten by a cascade.
  -- Anything needed to keep the row interpretable is snapshotted into payload.
  source_type TEXT NOT NULL CHECK (char_length(source_type) BETWEEN 1 AND 32),
  source_id UUID,

  -- Two clocks. `occurred_at` is when it happened in the user's world;
  -- `recorded_at` is when Cortex learned it. They diverge whenever an
  -- observation is written after the request that caused it, which is the
  -- normal path. Named `recorded_at` rather than `created_at` so the
  -- distinction cannot be read as a naming accident.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Structured references to surrounding entities (conversation, document, job).
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Event-specific detail. Small by construction, see the size CHECK below.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Set by writers that may run more than once (retries, replays). NULLs are
  -- distinct in a Postgres unique index, so events that need no idempotency
  -- key simply leave it NULL.
  dedupe_key TEXT CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),

  CONSTRAINT observations_context_is_object CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT observations_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  -- Enforces the "reference, do not duplicate" rule mechanically. Answer text,
  -- document bodies, and chunk content already have a durable home and must be
  -- referenced through source_id, never copied in here.
  CONSTRAINT observations_payload_size CHECK (octet_length(payload::text) <= 8000),
  CONSTRAINT observations_context_size CHECK (octet_length(context::text) <= 2000)
);

-- Primary timeline read: "this user's history, newest first". The id tiebreak
-- keeps keyset pagination stable when timestamps collide.
CREATE INDEX observations_user_occurred_idx
  ON public.observations (user_id, occurred_at DESC, id DESC);

-- "Every time this user did X" — the shape every later derivation starts from.
CREATE INDEX observations_user_type_occurred_idx
  ON public.observations (user_id, event_type, occurred_at DESC);

-- Provenance lookup: "everything that ever happened to this document/message".
CREATE INDEX observations_user_source_idx
  ON public.observations (user_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- Non-partial so `ON CONFLICT (user_id, dedupe_key)` can infer it. NULL
-- dedupe keys stay unconstrained because NULLs are distinct by default.
CREATE UNIQUE INDEX observations_user_dedupe_key
  ON public.observations (user_id, dedupe_key);

ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own observations"
ON public.observations FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can record their own observations"
ON public.observations FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Erasure is a privacy right and stays available. Append-only forbids
-- rewriting history, not deleting it: there is deliberately no UPDATE policy.
CREATE POLICY "Users can erase their own observations"
ON public.observations FOR DELETE
USING (auth.uid() = user_id);

-- Append-only enforced structurally rather than by convention. A trigger also
-- binds the service role, which RLS policies do not.
CREATE OR REPLACE FUNCTION public.reject_observation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'observations is append-only: rows cannot be updated'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER observations_reject_update
BEFORE UPDATE ON public.observations
FOR EACH ROW EXECUTE FUNCTION public.reject_observation_update();

COMMENT ON TABLE public.observations IS
  'Append-only log of events that actually happened. Never inferences. Rows may be deleted for erasure but never updated.';
COMMENT ON COLUMN public.observations.occurred_at IS 'When the event happened in the user''s world.';
COMMENT ON COLUMN public.observations.recorded_at IS 'When Cortex durably learned about the event.';
COMMENT ON COLUMN public.observations.source_id IS 'Provenance pointer. Intentionally not a foreign key so history survives source deletion.';
COMMENT ON COLUMN public.observations.payload IS 'Event-specific detail, size-capped. Reference large content via source_id instead of copying it here.';
