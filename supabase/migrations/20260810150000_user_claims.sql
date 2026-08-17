-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Milestone 3: explicit, evidence-backed claims.
--
-- A user_claim records something the user EXPLICITLY SAID about their own
-- thinking. It is not an inference. Cortex concluding something from several
-- observations is a later milestone, and the `asserted_by` column exists so
-- that work does not need to reshape this table -- but nothing in M3 writes
-- anything other than 'user'.
--
-- Three invariants are enforced by the database rather than by convention:
--
--   1. A claim cannot exist without evidence. A deferred constraint trigger
--      rejects any claim that reaches commit with none.
--   2. Evidence cannot dangle. `observation_id` cascades, and a claim whose
--      last evidence disappears is removed with it.
--   3. History is not overwritten. Restating a claim adds evidence; retracting
--      or archiving sets `valid_to` and never edits `statement`.

CREATE TABLE public.user_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Owned by lib/claims/types.ts and validated at the write boundary, for the
  -- same reason `observations.event_type` is TEXT: adding a category should be
  -- a typed code change, not an ALTER TYPE against live history.
  claim_type TEXT NOT NULL CHECK (char_length(claim_type) BETWEEN 1 AND 32),

  -- Who asserted this. Never collapsed: "you said X" and "Cortex infers X" are
  -- categorically different objects and must stay distinguishable forever.
  asserted_by TEXT NOT NULL DEFAULT 'user' CHECK (asserted_by IN ('user', 'cortex')),

  -- Human-readable, third person, derived from the user's own words.
  statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 3 AND 500),
  -- Deterministic normalisation of `statement`, and the claim's identity.
  canonical_key TEXT NOT NULL CHECK (char_length(canonical_key) BETWEEN 3 AND 500),

  -- Stored for future revision and contradiction work. Deliberately NOT used
  -- for identity in M3: an incorrect semantic merge destroys intellectual
  -- history, while a duplicate claim can be merged later at no loss.
  statement_embedding vector(1536),
  embedding_model TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'retracted', 'superseded')),

  -- For an explicitly stated claim there is nothing to be uncertain about: the
  -- user said it. `confidence_method` exists so that a number always has a
  -- derivation rather than being decoration.
  confidence NUMERIC NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  confidence_method TEXT NOT NULL DEFAULT 'user_stated',

  -- Temporal validity. `valid_from` is when the user first said it, not when
  -- the row was written.
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  superseded_by UUID REFERENCES public.user_claims(id) ON DELETE SET NULL,

  first_stated_at TIMESTAMPTZ NOT NULL,
  last_stated_at TIMESTAMPTZ NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),

  -- Explicit mapping for claims migrated from the legacy `memories` table, so
  -- the old system's identity is preserved rather than guessed at later.
  source_memory_id UUID REFERENCES public.memories(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One idea, one row. Conservative by construction: only an exact canonical
  -- match is treated as the same claim.
  UNIQUE (user_id, claim_type, canonical_key),
  CONSTRAINT user_claims_validity_ordered CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Anything no longer current must say when it stopped being current.
  CONSTRAINT user_claims_closed_when_inactive
    CHECK (status = 'active' OR valid_to IS NOT NULL)
);

CREATE INDEX user_claims_user_status_idx
  ON public.user_claims (user_id, status, last_stated_at DESC);
CREATE INDEX user_claims_user_type_idx
  ON public.user_claims (user_id, claim_type, status);
CREATE INDEX user_claims_superseded_by_idx ON public.user_claims (superseded_by);
CREATE INDEX user_claims_source_memory_idx ON public.user_claims (source_memory_id);

CREATE TRIGGER user_claims_set_updated_at
BEFORE UPDATE ON public.user_claims
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------

CREATE TABLE public.claim_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL REFERENCES public.user_claims(id) ON DELETE CASCADE,

  -- Cascades on purpose. A user deleting an observation is exercising erasure,
  -- and evidence that outlived the event it describes would be a lie.
  observation_id UUID NOT NULL REFERENCES public.observations(id) ON DELETE CASCADE,

  relation TEXT NOT NULL DEFAULT 'originates'
    CHECK (relation IN ('originates', 'supports', 'contradicts')),

  -- Grounding, for evidence that comes from a message. Null for evidence that
  -- has no span (a future inferred claim citing a measured outcome, say).
  source_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  char_start INTEGER CHECK (char_start IS NULL OR char_start >= 0),
  char_end INTEGER,
  -- Snapshot of the user's actual words, so the evidence stays readable even
  -- after the message is gone.
  excerpt TEXT CHECK (excerpt IS NULL OR char_length(excerpt) BETWEEN 1 AND 2000),

  -- When the evidencing event happened, copied from the observation so the
  -- timeline survives independently.
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT claim_evidence_span_valid
    CHECK ((char_start IS NULL AND char_end IS NULL)
        OR (char_start IS NOT NULL AND char_end IS NOT NULL AND char_end > char_start)),
  UNIQUE (claim_id, observation_id, relation)
);

CREATE INDEX claim_evidence_claim_idx ON public.claim_evidence (claim_id, occurred_at DESC);
CREATE INDEX claim_evidence_observation_idx ON public.claim_evidence (observation_id);
CREATE INDEX claim_evidence_user_idx ON public.claim_evidence (user_id);

-- ---------------------------------------------------------------------------
-- Invariant 1: no claim without evidence.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_claim_has_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.claim_evidence e WHERE e.claim_id = NEW.id) THEN
    RAISE EXCEPTION 'Claim % has no evidence; a user claim cannot exist without it', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- Deferred so a claim and its evidence can be written in one transaction, but
-- checked before that transaction is allowed to commit.
CREATE CONSTRAINT TRIGGER user_claims_require_evidence
AFTER INSERT ON public.user_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_claim_has_evidence();

-- ---------------------------------------------------------------------------
-- Invariant 2: a claim does not outlive its last evidence.
-- ---------------------------------------------------------------------------

/**
 * Handles evidence removal in one place, in a fixed order.
 *
 * Counting and pruning are deliberately not two triggers: their order matters,
 * and depending on Postgres firing triggers in name order would make a rename
 * silently change behaviour.
 */
CREATE OR REPLACE FUNCTION public.handle_claim_evidence_removed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Counts first, so a claim that survives on remaining evidence reports the
  -- truth rather than the count it had before the deletion.
  UPDATE public.user_claims c
  SET evidence_count = (
    SELECT COUNT(*) FROM public.claim_evidence e WHERE e.claim_id = c.id
  )
  WHERE c.id IN (SELECT DISTINCT r.claim_id FROM removed_evidence r);

  DELETE FROM public.user_claims c
  WHERE c.id IN (SELECT DISTINCT r.claim_id FROM removed_evidence r)
    AND NOT EXISTS (SELECT 1 FROM public.claim_evidence e WHERE e.claim_id = c.id);

  RETURN NULL;
END;
$$;

CREATE TRIGGER claim_evidence_on_removed
AFTER DELETE ON public.claim_evidence
REFERENCING OLD TABLE AS removed_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.handle_claim_evidence_removed();

-- Keeps `evidence_count` honest without a separate rebuild pass.
CREATE OR REPLACE FUNCTION public.refresh_claim_evidence_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.user_claims c
  SET evidence_count = (
    SELECT COUNT(*) FROM public.claim_evidence e WHERE e.claim_id = c.id
  )
  WHERE c.id = COALESCE(NEW.claim_id, OLD.claim_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER claim_evidence_count_on_insert
AFTER INSERT ON public.claim_evidence
FOR EACH ROW EXECUTE FUNCTION public.refresh_claim_evidence_count();

-- ---------------------------------------------------------------------------
-- RLS: read and erase your own; every write goes through a definer function so
-- a client can neither forge a claim nor edit a statement it did not make.
-- ---------------------------------------------------------------------------

ALTER TABLE public.user_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own claims"
ON public.user_claims FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can erase their own claims"
ON public.user_claims FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.claim_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own claim evidence"
ON public.claim_evidence FOR SELECT USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Recording explicit claims
-- ---------------------------------------------------------------------------

/**
 * Writes the claims extracted from one user message, atomically.
 *
 * Every candidate must already have been grounded in application code; this
 * re-verifies the span against the stored message as defense in depth. A
 * candidate whose excerpt is not literally present is a programming error, not
 * a data condition, so it aborts the batch rather than being silently dropped.
 *
 * Restating an existing claim attaches evidence to it. It never creates a
 * second row and never rewrites the original statement.
 */
CREATE OR REPLACE FUNCTION public.record_user_claims(
  target_message_id UUID,
  candidates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Derived from the session rather than taken as a parameter. A definer
  -- function that trusts a caller-supplied user id can be pointed at anyone.
  target_user_id UUID := auth.uid();
  candidate JSONB;
  message_content TEXT;
  stated_at TIMESTAMPTZ;
  conversation UUID;
  resolved_observation_id UUID;
  resolved_claim_id UUID;
  span_start INTEGER;
  span_end INTEGER;
  excerpt_text TEXT;
  canonical TEXT;
  claims_created INTEGER := 0;
  claims_reinforced INTEGER := 0;
  evidence_written INTEGER := 0;
  affected INTEGER;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT m.content, m.created_at, m.conversation_id
  INTO message_content, stated_at, conversation
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.id = target_message_id
    AND c.user_id = target_user_id
    AND m.role = 'user';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Message % is not a user message belonging to %',
      target_message_id, target_user_id;
  END IF;

  IF candidates IS NULL OR jsonb_typeof(candidates) <> 'array' THEN
    RAISE EXCEPTION 'candidates must be a JSON array';
  END IF;

  FOR candidate IN SELECT * FROM jsonb_array_elements(candidates)
  LOOP
    span_start := (candidate->>'charStart')::INTEGER;
    span_end := (candidate->>'charEnd')::INTEGER;
    excerpt_text := candidate->>'excerpt';
    canonical := candidate->>'canonicalKey';

    IF span_start IS NULL OR span_end IS NULL OR span_end <= span_start THEN
      RAISE EXCEPTION 'Claim candidate has an invalid span';
    END IF;

    -- The grounding guarantee, restated in SQL: the user's own words must be
    -- exactly where the candidate says they are.
    IF substring(message_content FROM span_start + 1 FOR span_end - span_start)
       IS DISTINCT FROM excerpt_text THEN
      RAISE EXCEPTION 'Claim excerpt does not match message % at [%, %]',
        target_message_id, span_start, span_end;
    END IF;

    -- The immutable record that the user said this. Written before the claim so
    -- the claim always has evidence available within the transaction.
    INSERT INTO public.observations (
      user_id, event_type, event_category, actor, source_type, source_id,
      occurred_at, context, payload, dedupe_key
    )
    VALUES (
      target_user_id, 'claim_stated', 'explicit_signal', 'user', 'message',
      target_message_id, stated_at,
      jsonb_build_object('conversationId', conversation, 'messageId', target_message_id),
      jsonb_build_object(
        'claimType', candidate->>'claimType',
        'canonicalKey', canonical,
        'statement', candidate->>'statement',
        'excerpt', excerpt_text,
        'charStart', span_start,
        'charEnd', span_end
      ),
      'claim_stated:' || target_message_id::TEXT || ':' || left(md5(canonical), 32)
    )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id INTO resolved_observation_id;

    IF resolved_observation_id IS NULL THEN
      SELECT o.id INTO resolved_observation_id
      FROM public.observations o
      WHERE o.user_id = target_user_id
        AND o.dedupe_key =
          'claim_stated:' || target_message_id::TEXT || ':' || left(md5(canonical), 32);
    END IF;

    SELECT c.id INTO resolved_claim_id
    FROM public.user_claims c
    WHERE c.user_id = target_user_id
      AND c.claim_type = candidate->>'claimType'
      AND c.canonical_key = canonical;

    IF resolved_claim_id IS NULL THEN
      INSERT INTO public.user_claims (
        user_id, claim_type, asserted_by, statement, canonical_key,
        statement_embedding, embedding_model,
        valid_from, first_stated_at, last_stated_at
      )
      VALUES (
        target_user_id,
        candidate->>'claimType',
        'user',
        candidate->>'statement',
        canonical,
        public.jsonb_to_vector(candidate->'embedding'),
        candidate->>'embeddingModel',
        stated_at, stated_at, stated_at
      )
      RETURNING id INTO resolved_claim_id;
      claims_created := claims_created + 1;
    ELSE
      -- Saying it again is more evidence, not a new claim and not a rewrite.
      UPDATE public.user_claims
      SET last_stated_at = GREATEST(last_stated_at, stated_at),
          first_stated_at = LEAST(first_stated_at, stated_at),
          valid_from = LEAST(valid_from, stated_at),
          statement_embedding = COALESCE(statement_embedding, public.jsonb_to_vector(candidate->'embedding')),
          embedding_model = COALESCE(embedding_model, candidate->>'embeddingModel')
      WHERE id = resolved_claim_id;
      claims_reinforced := claims_reinforced + 1;
    END IF;

    INSERT INTO public.claim_evidence (
      user_id, claim_id, observation_id, relation,
      source_message_id, char_start, char_end, excerpt, occurred_at
    )
    VALUES (
      target_user_id, resolved_claim_id, resolved_observation_id, 'originates',
      target_message_id, span_start, span_end, excerpt_text, stated_at
    )
    ON CONFLICT (claim_id, observation_id, relation) DO NOTHING;

    GET DIAGNOSTICS affected = ROW_COUNT;
    evidence_written := evidence_written + affected;
  END LOOP;

  RETURN jsonb_build_object(
    'claimsCreated', claims_created,
    'claimsReinforced', claims_reinforced,
    'evidenceWritten', evidence_written
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_claims(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_user_claims(UUID, JSONB) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Correction: the user's own path to fix what Cortex holds about them
-- ---------------------------------------------------------------------------

/**
 * Closes a claim without erasing it.
 *
 * 'archived' means the user does not want it surfaced; 'retracted' means they
 * say it no longer represents them. Both preserve the statement and its
 * evidence, because a claim the user changed their mind about is itself part of
 * their intellectual history.
 */
CREATE OR REPLACE FUNCTION public.close_user_claim(
  target_claim_id UUID,
  new_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
  updated INTEGER;
  event TEXT;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF new_status NOT IN ('archived', 'retracted', 'active') THEN
    RAISE EXCEPTION 'Unsupported claim status %', new_status;
  END IF;

  UPDATE public.user_claims
  SET status = new_status,
      valid_to = CASE WHEN new_status = 'active' THEN NULL ELSE NOW() END
  WHERE id = target_claim_id AND user_id = current_user_id;
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated = 0 THEN
    RETURN jsonb_build_object('updated', 0);
  END IF;

  -- The correction is itself something that happened, and a future model of how
  -- this person's thinking changes will want it.
  event := CASE new_status
    WHEN 'archived' THEN 'claim_archived'
    WHEN 'retracted' THEN 'claim_retracted'
    ELSE 'claim_restored'
  END;

  INSERT INTO public.observations (
    user_id, event_type, event_category, actor, source_type, source_id,
    occurred_at, context, payload
  )
  SELECT current_user_id, event, 'explicit_signal', 'user', 'claim', c.id, NOW(),
         '{}'::jsonb,
         jsonb_build_object('claimType', c.claim_type, 'canonicalKey', c.canonical_key)
  FROM public.user_claims c
  WHERE c.id = target_claim_id;

  RETURN jsonb_build_object('updated', updated);
END;
$$;

REVOKE ALL ON FUNCTION public.close_user_claim(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_user_claim(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Identity continuity with the legacy `memories` table
-- ---------------------------------------------------------------------------

/**
 * Maps a memory to a claim, creating the evidencing observation when the memory
 * predates the observation log.
 *
 * `memories` is deliberately left in place: it keeps working, `memory_stated`
 * observations keep pointing at `memories.id`, and `user_claims.source_memory_id`
 * records the mapping explicitly rather than leaving it to be guessed later.
 */
CREATE OR REPLACE FUNCTION public.sync_memory_claim(target_memory_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  memory RECORD;
  resolved_observation_id UUID;
  resolved_claim_id UUID;
  canonical TEXT;
  statement_text TEXT;
BEGIN
  SELECT m.id, m.user_id, m.content, m.created_at, m.status
  INTO memory
  FROM public.memories m
  WHERE m.id = target_memory_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- auth.uid() is NULL for the backfill below and for service-role callers; an
  -- authenticated caller may only ever reach their own memory.
  IF auth.uid() IS NOT NULL AND memory.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Memory % does not belong to the caller', target_memory_id;
  END IF;

  statement_text := left(memory.content, 500);
  canonical := left(
    trim(regexp_replace(lower(memory.content), '[^a-z0-9]+', ' ', 'g')),
    500
  );
  IF char_length(canonical) < 3 THEN
    RETURN NULL;
  END IF;

  SELECT o.id INTO resolved_observation_id
  FROM public.observations o
  WHERE o.user_id = memory.user_id
    AND o.dedupe_key = 'memory_stated:' || memory.id::TEXT;

  IF resolved_observation_id IS NULL THEN
    INSERT INTO public.observations (
      user_id, event_type, event_category, actor, source_type, source_id,
      occurred_at, context, payload, dedupe_key
    )
    VALUES (
      memory.user_id, 'memory_stated', 'explicit_signal', 'user', 'memory',
      memory.id, memory.created_at, '{}'::jsonb,
      jsonb_build_object('characterCount', char_length(memory.content)),
      'memory_stated:' || memory.id::TEXT
    )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id INTO resolved_observation_id;

    IF resolved_observation_id IS NULL THEN
      SELECT o.id INTO resolved_observation_id FROM public.observations o
      WHERE o.user_id = memory.user_id
        AND o.dedupe_key = 'memory_stated:' || memory.id::TEXT;
    END IF;
  END IF;

  SELECT c.id INTO resolved_claim_id
  FROM public.user_claims c
  WHERE c.user_id = memory.user_id
    AND c.claim_type = 'note'
    AND c.canonical_key = canonical;

  IF resolved_claim_id IS NULL THEN
    INSERT INTO public.user_claims (
      user_id, claim_type, asserted_by, statement, canonical_key,
      confidence_method, valid_from, first_stated_at, last_stated_at,
      source_memory_id,
      status, valid_to
    )
    VALUES (
      memory.user_id, 'note', 'user', statement_text, canonical,
      'user_stated_memory', memory.created_at, memory.created_at, memory.created_at,
      memory.id,
      CASE WHEN memory.status = 'active' THEN 'active' ELSE 'archived' END,
      CASE WHEN memory.status = 'active' THEN NULL ELSE NOW() END
    )
    RETURNING id INTO resolved_claim_id;
  END IF;

  INSERT INTO public.claim_evidence (
    user_id, claim_id, observation_id, relation, occurred_at
  )
  VALUES (memory.user_id, resolved_claim_id, resolved_observation_id, 'originates', memory.created_at)
  ON CONFLICT (claim_id, observation_id, relation) DO NOTHING;

  RETURN resolved_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_memory_claim(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_memory_claim(UUID) TO authenticated, service_role;

-- Backfill every existing memory. Idempotent, so a re-run is harmless.
DO $$
DECLARE
  memory_id UUID;
BEGIN
  FOR memory_id IN SELECT id FROM public.memories ORDER BY created_at
  LOOP
    PERFORM public.sync_memory_claim(memory_id);
  END LOOP;
END;
$$;

COMMENT ON TABLE public.user_claims IS
  'What the user explicitly said they think, want, believe, care about, or are trying to understand. Never an inference.';
COMMENT ON COLUMN public.user_claims.asserted_by IS
  'Who asserted the claim. M3 only ever writes ''user''; ''cortex'' is reserved for evidence-backed inference in a later milestone.';
COMMENT ON TABLE public.claim_evidence IS
  'Links a claim to the observation that evidences it. Cascades with the observation so evidence can never dangle.';
