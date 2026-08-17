-- Close the retrieval-attribution gap for new citations.
--
-- `evidence_cited` used to resolve to a concept only by joining
-- `source_id` -> `concept_mentions`, which cascades away with its document. A
-- user deleting a document therefore erased its own retrieval history from the
-- knowledge-state projection.
--
-- Citations written from now on carry `conceptIds` and `conceptKeys` in their
-- payload, captured while the mentions still existed. Resolution prefers that
-- snapshot and falls back to the chunk join only for observations written
-- before this change, so the accepted limitation stands for existing history and
-- is closed going forward. Nothing is backfilled: a payload cannot be
-- reconstructed for a citation whose document is already gone, and inventing one
-- would be worse than recording the gap.
--
-- Purity is unchanged: every column is still a COUNT/MIN/MAX over observations,
-- and TRUNCATE + rebuild still reproduces byte-identical state.

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
  citations AS (
    SELECT
      o.id,
      o.source_id,
      o.occurred_at,
      o.context->>'messageId' AS message_id,
      o.payload,
      -- A citation is "attributed" when it carries either snapshot list.
      -- COALESCE is load-bearing: for a payload with no such key,
      -- `payload->'conceptIds'` is SQL NULL, so `jsonb_typeof(...) = 'array'`
      -- yields NULL rather than false, and `NOT attributed` would then be NULL
      -- and silently match nothing in the fallback branch below.
      COALESCE(
        (jsonb_typeof(o.payload->'conceptIds') = 'array'
          AND jsonb_array_length(o.payload->'conceptIds') > 0)
        OR (jsonb_typeof(o.payload->'conceptKeys') = 'array'
          AND jsonb_array_length(o.payload->'conceptKeys') > 0),
        FALSE
      ) AS attributed
    FROM public.observations o
    WHERE o.user_id = target_user_id
      AND o.event_type = 'evidence_cited'
  ),
  attributed_by_key AS (
    -- Preferred path: the canonical key is a concept's durable identity, so it
    -- still resolves after a prune-and-recreate cycle that changes the row id.
    SELECT c.id AS concept_id, x.id AS observation_id, x.occurred_at, x.message_id
    FROM citations x
    CROSS JOIN LATERAL jsonb_array_elements_text(x.payload->'conceptKeys') AS k(canonical_key)
    JOIN public.concepts c
      ON c.user_id = target_user_id AND c.canonical_key = k.canonical_key
    WHERE x.attributed
      AND jsonb_typeof(x.payload->'conceptKeys') = 'array'
  ),
  attributed_by_id AS (
    SELECT c.id AS concept_id, x.id AS observation_id, x.occurred_at, x.message_id
    FROM citations x
    CROSS JOIN LATERAL jsonb_array_elements_text(x.payload->'conceptIds') AS i(concept_id)
    JOIN public.concepts c
      ON c.user_id = target_user_id AND c.id = i.concept_id::UUID
    WHERE x.attributed
      AND jsonb_typeof(x.payload->'conceptIds') = 'array'
  ),
  attributed_by_chunk AS (
    -- Fallback for citations written before attribution existed.
    SELECT m.concept_id, x.id AS observation_id, x.occurred_at, x.message_id
    FROM citations x
    JOIN public.concept_mentions m
      ON m.chunk_id = x.source_id
     AND m.user_id = target_user_id
    WHERE NOT x.attributed
  ),
  retrieval_events AS (
    -- UNION, not UNION ALL: one citation resolving through both the key and the
    -- id lists is still one retrieval.
    SELECT concept_id, observation_id, occurred_at, message_id FROM attributed_by_key
    UNION
    SELECT concept_id, observation_id, occurred_at, message_id FROM attributed_by_id
    UNION
    SELECT concept_id, observation_id, occurred_at, message_id FROM attributed_by_chunk
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

-- Speeds the fallback path's scan over citations.
CREATE INDEX IF NOT EXISTS observations_evidence_cited_source_idx
  ON public.observations (user_id, source_id)
  WHERE event_type = 'evidence_cited';
