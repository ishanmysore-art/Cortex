-- Milestone 4: knowledge states.
--
-- A per-concept projection of what the observation log already records: how
-- often the user has met an idea, how often it has been used to answer them,
-- and when. Nothing new is instrumented; this only reads.
--
-- The defining property is that it is NOT a source of truth. Every column is a
-- COUNT, MIN, or MAX over `observations`, so the whole table can be discarded
-- and rebuilt to byte-identical state. There is deliberately no bookkeeping
-- column (no `rebuilt_at`) precisely so that `SELECT *` before and after a
-- rebuild can be compared verbatim — a wall clock in the row would make the
-- purity claim untestable.
--
-- What this table deliberately does NOT contain: any mastery, familiarity,
-- confidence, or strength score; any forgetting curve, half-life, or decay; any
-- notion of a retrieval having succeeded or failed. Nothing in the log
-- distinguishes a citation that helped from one that did not, so inferring it
-- would be exactly the unsupported step this architecture exists to avoid.

CREATE TABLE public.knowledge_states (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,

  -- `concept_encountered` observations for this concept.
  encounter_count INTEGER NOT NULL DEFAULT 0 CHECK (encounter_count >= 0),
  -- Distinct documents those encounters came from.
  encounter_document_count INTEGER NOT NULL DEFAULT 0 CHECK (encounter_document_count >= 0),
  first_encountered_at TIMESTAMPTZ,
  last_encountered_at TIMESTAMPTZ,

  -- `evidence_cited` observations whose chunk mentions this concept.
  retrieval_count INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_count >= 0),
  -- Distinct answers that drew on it, so one answer citing four passages of the
  -- same idea counts once here and four times above.
  retrieval_answer_count INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_answer_count >= 0),
  first_retrieved_at TIMESTAMPTZ,
  last_retrieved_at TIMESTAMPTZ,

  -- Newest observation folded into this row, by (occurred_at, id). Deterministic,
  -- so it survives the byte-identical rebuild comparison, and it records which
  -- point in the log the row reflects.
  derived_through_observation_id UUID,

  PRIMARY KEY (user_id, concept_id)
);

CREATE INDEX knowledge_states_user_encounters_idx
  ON public.knowledge_states (user_id, encounter_count DESC);
CREATE INDEX knowledge_states_user_last_encountered_idx
  ON public.knowledge_states (user_id, last_encountered_at DESC);

-- Read-only to the client, enforced twice. RLS scopes which rows are visible;
-- withdrawing the write privileges means a client cannot write any row at all,
-- not even one it owns. A projection a client can edit is no longer a
-- projection, and the rebuild function is the only writer.
ALTER TABLE public.knowledge_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own knowledge states"
ON public.knowledge_states FOR SELECT USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.knowledge_states FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.knowledge_states FROM anon;

/**
 * Recomputes one user's knowledge states from the observation log.
 *
 * Reads exactly two event types:
 *   `concept_encountered` — joined to concepts by canonical key, not by
 *     source_id, because a concept pruned and recreated gets a new row id while
 *     the key is its durable identity. Joining on the id would silently drop the
 *     history of an idea the user met before a re-ingest.
 *   `evidence_cited`      — joined chunk -> concept_mentions -> concept.
 *
 * Known limitation, accepted for this milestone: `concept_mentions` is derived
 * state that cascades away with its document, so retrievals attributed to a
 * document the user has since deleted cannot be reconstructed. The rebuild is
 * exactly reproducible from currently retained data, which is what the purity
 * test asserts; it is not a reconstruction of all history. Closing that would
 * require recording concept ids on `evidence_cited` at write time, which is new
 * instrumentation and out of scope here.
 */
CREATE OR REPLACE FUNCTION public.rebuild_knowledge_states(target_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  written INTEGER := 0;
BEGIN
  DELETE FROM public.knowledge_states WHERE user_id = target_user_id;

  WITH encounter_events AS (
    SELECT
      c.id AS concept_id,
      o.id AS observation_id,
      o.occurred_at,
      o.context->>'documentId' AS document_id
    FROM public.observations o
    JOIN public.concepts c
      ON c.user_id = o.user_id
     AND c.canonical_key = o.payload->>'canonicalKey'
    WHERE o.user_id = target_user_id
      AND o.event_type = 'concept_encountered'
  ),
  retrieval_events AS (
    -- DISTINCT because one chunk can mention a concept several times; a single
    -- citation is one retrieval regardless of how many spans it covers.
    SELECT DISTINCT
      m.concept_id,
      o.id AS observation_id,
      o.occurred_at,
      o.context->>'messageId' AS message_id
    FROM public.observations o
    JOIN public.concept_mentions m
      ON m.chunk_id = o.source_id
     AND m.user_id = o.user_id
    WHERE o.user_id = target_user_id
      AND o.event_type = 'evidence_cited'
  ),
  contributing AS (
    SELECT concept_id, observation_id, occurred_at FROM encounter_events
    UNION ALL
    SELECT concept_id, observation_id, occurred_at FROM retrieval_events
  ),
  watermark AS (
    SELECT DISTINCT ON (concept_id) concept_id, observation_id
    FROM contributing
    ORDER BY concept_id, occurred_at DESC, observation_id DESC
  ),
  encounters AS (
    SELECT
      concept_id,
      COUNT(*)::INTEGER AS total,
      COUNT(DISTINCT document_id)::INTEGER AS documents,
      MIN(occurred_at) AS first_at,
      MAX(occurred_at) AS last_at
    FROM encounter_events
    GROUP BY concept_id
  ),
  retrievals AS (
    SELECT
      concept_id,
      COUNT(*)::INTEGER AS total,
      COUNT(DISTINCT message_id)::INTEGER AS answers,
      MIN(occurred_at) AS first_at,
      MAX(occurred_at) AS last_at
    FROM retrieval_events
    GROUP BY concept_id
  )
  INSERT INTO public.knowledge_states (
    user_id, concept_id,
    encounter_count, encounter_document_count, first_encountered_at, last_encountered_at,
    retrieval_count, retrieval_answer_count, first_retrieved_at, last_retrieved_at,
    derived_through_observation_id
  )
  SELECT
    c.user_id,
    c.id,
    COALESCE(e.total, 0),
    COALESCE(e.documents, 0),
    e.first_at,
    e.last_at,
    COALESCE(r.total, 0),
    COALESCE(r.answers, 0),
    r.first_at,
    r.last_at,
    w.observation_id
  -- Keyed on concepts, so the projection covers exactly the ideas that still
  -- exist. A concept whose evidencing observations were erased appears with
  -- zeroes rather than vanishing, which is the honest answer.
  FROM public.concepts c
  LEFT JOIN encounters e ON e.concept_id = c.id
  LEFT JOIN retrievals r ON r.concept_id = c.id
  LEFT JOIN watermark w ON w.concept_id = c.id
  WHERE c.user_id = target_user_id;

  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_knowledge_states(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_knowledge_states(UUID) TO service_role;

/**
 * Refreshes the caller's own knowledge states.
 *
 * Takes no user argument on purpose: it acts only on `auth.uid()`, so an
 * authenticated caller cannot reach another user's projection.
 */
CREATE OR REPLACE FUNCTION public.refresh_my_knowledge_states()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RETURN 0;
  END IF;
  RETURN public.rebuild_knowledge_states(current_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_my_knowledge_states() FROM PUBLIC;
-- Granted to the service role too so the null-caller guard above is reachable;
-- a background worker has no `auth.uid()` and should use
-- `rebuild_knowledge_states(user_id)` instead of this.
GRANT EXECUTE ON FUNCTION public.refresh_my_knowledge_states() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fold the new projection into the existing concept rebuild.
--
-- `rebuild_concept_projections` already means "recompute every derived concept
-- projection for this user", and knowledge states are one. Extending it here
-- means both existing callers -- `sync_document_concepts` and
-- `prune_orphan_concepts` -- pick it up with no change of their own, and there
-- is still exactly one place where derived concept state is produced.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rebuild_concept_projections(target_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pruned INTEGER := 0;
  edges INTEGER := 0;
  states INTEGER := 0;
BEGIN
  UPDATE public.concepts c
  SET mention_count = s.mentions,
      document_count = s.documents,
      first_seen_at = s.first_encounter,
      last_seen_at = s.last_encounter
  FROM (
    SELECT concept_id,
           COUNT(*)::INTEGER AS mentions,
           COUNT(DISTINCT document_id)::INTEGER AS documents,
           MIN(encountered_at) AS first_encounter,
           MAX(encountered_at) AS last_encounter
    FROM public.concept_mentions
    WHERE user_id = target_user_id
    GROUP BY concept_id
  ) s
  WHERE c.id = s.concept_id;

  DELETE FROM public.concepts c
  WHERE c.user_id = target_user_id
    AND NOT EXISTS (
      SELECT 1 FROM public.concept_mentions m WHERE m.concept_id = c.id
    );
  GET DIAGNOSTICS pruned = ROW_COUNT;

  DELETE FROM public.concept_edges WHERE user_id = target_user_id;

  INSERT INTO public.concept_edges (
    user_id, from_concept_id, to_concept_id, relation, evidence_count, document_count
  )
  SELECT
    target_user_id,
    a.concept_id,
    b.concept_id,
    'co_occurs_with',
    COUNT(DISTINCT a.chunk_id)::INTEGER,
    COUNT(DISTINCT a.document_id)::INTEGER
  FROM public.concept_mentions a
  JOIN public.concept_mentions b
    ON b.chunk_id = a.chunk_id
   AND b.user_id = a.user_id
   AND b.concept_id > a.concept_id
  WHERE a.user_id = target_user_id
  GROUP BY a.concept_id, b.concept_id;
  GET DIAGNOSTICS edges = ROW_COUNT;

  -- Runs last: it keys on `concepts`, so it must see the pruned set.
  states := public.rebuild_knowledge_states(target_user_id);

  RETURN jsonb_build_object('prunedConcepts', pruned, 'edges', edges, 'knowledgeStates', states);
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_concept_projections(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_concept_projections(UUID) TO service_role;

-- Populate the projection for data that already exists.
DO $$
DECLARE
  affected_user UUID;
BEGIN
  FOR affected_user IN SELECT DISTINCT user_id FROM public.concepts
  LOOP
    PERFORM public.rebuild_knowledge_states(affected_user);
  END LOOP;
END;
$$;

COMMENT ON TABLE public.knowledge_states IS
  'Derived per-concept counts and timestamps from the observation log. Rebuildable and never authoritative: discard and rebuild reproduces it exactly. Contains no mastery, confidence, or forgetting signal.';
COMMENT ON COLUMN public.knowledge_states.derived_through_observation_id IS
  'Newest observation folded into this row, by (occurred_at, id). Deterministic, so a rebuild reproduces it.';
