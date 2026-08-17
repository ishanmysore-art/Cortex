-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Tier 1 corrections to the Milestone 2 concept layer.
--
-- Three defects, all of which get more expensive the longer they run:
--
--   1. Concept timestamps were anchored to row-write time. `sync_document_concepts`
--      replaces a document's mentions on every run, so `last_seen_at` tracked
--      "last reprocessed" rather than "last encountered" -- and a bulk re-ingest
--      flattened every concept's recency to one moment. That is precisely the
--      signal the retention and interest models will be built on.
--
--   2. Concept encounters lived only in `concept_mentions`, which is derived,
--      deletable, and cascades with its document. A future claim needs immutable
--      evidence to point at, and a payload array is not a joinable target.
--
--   3. The HNSW index on `concepts.embedding` is global, and an approximate scan
--      under a user_id post-filter can discard a user's true nearest neighbour,
--      returning nothing and manufacturing a duplicate concept.
--
--      Measured with EXPLAIN, the planner was NOT in fact choosing that index:
--      it filters on user_id first and sorts the small remainder, so the lookup
--      was still exact. The defect is therefore latent rather than active -- a
--      cliff that appears once one user's concept count makes an index-ordered
--      scan look cheaper. Removing the index removes the cliff outright, and at
--      per-user counts in the hundreds it costs nothing.

-- ---------------------------------------------------------------------------
-- 1. Encounter time
-- ---------------------------------------------------------------------------

ALTER TABLE public.concept_mentions
  ADD COLUMN IF NOT EXISTS encountered_at TIMESTAMPTZ;

-- Existing rows are re-anchored to when the user added the document. `created_at`
-- is only a fallback for a mention whose document has already gone.
UPDATE public.concept_mentions m
SET encountered_at = d.created_at
FROM public.documents d
WHERE d.id = m.document_id AND m.encountered_at IS NULL;

UPDATE public.concept_mentions
SET encountered_at = created_at
WHERE encountered_at IS NULL;

ALTER TABLE public.concept_mentions
  ALTER COLUMN encountered_at SET NOT NULL;

COMMENT ON COLUMN public.concept_mentions.encountered_at IS
  'When the user encountered this material, taken from the document. Stable across re-ingest.';
COMMENT ON COLUMN public.concept_mentions.created_at IS
  'When this derived row was written. An audit clock, never an encounter time.';

-- Ordering a concept's history by when it was met, not when it was recomputed.
DROP INDEX IF EXISTS public.concept_mentions_concept_idx;
CREATE INDEX IF NOT EXISTS concept_mentions_concept_encountered_idx
  ON public.concept_mentions (concept_id, encountered_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Remove the approximate index that breaks tenant-scoped deduplication
-- ---------------------------------------------------------------------------

-- Deliberately left with no ANN index. Deduplication correctness depends on
-- finding the true nearest neighbour WITHIN one user's concepts, and an
-- approximate index cannot promise that under a post-filter. Per-user concept
-- counts are in the hundreds, so an exact scan is both correct and cheap.
--
-- Do not reintroduce an ANN index here without either per-user partitioning or
-- a validated iterative index scan; an index that silently returns nothing
-- manufactures duplicate concepts instead of merely being slow.
DROP INDEX IF EXISTS public.concepts_embedding_idx;

-- Keeps the exact scan on one user's concepts off a full table scan.
CREATE INDEX IF NOT EXISTS concepts_user_embedding_idx
  ON public.concepts (user_id)
  WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Projections, now derived from encounter time
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
BEGIN
  -- Assigned directly rather than folded into the previous value with
  -- LEAST/GREATEST. With a stable anchor the aggregate is already correct, and
  -- direct assignment lets a rebuild repair rows written by the old logic
  -- instead of preserving their drift forever.
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

  -- The hard rule, enforced. A concept whose last mention disappeared is no
  -- longer traceable to anything and must not survive. The encounter is not
  -- lost: `concept_encountered` observations retain it immutably.
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

  RETURN jsonb_build_object('prunedConcepts', pruned, 'edges', edges);
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_concept_projections(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_concept_projections(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Sync: encounter time, chunk ownership, embedding backfill, encounter events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_document_concepts(
  target_user_id UUID,
  target_document_id UUID,
  candidates JSONB,
  similarity_threshold DOUBLE PRECISION DEFAULT 0.95
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
-- `extensions` is on this function's search_path because it uses pgvector's
-- `<=>` operator and `vector` casts, which are resolved at execution time. A
-- SECURITY DEFINER `SET search_path` OVERRIDES the role default, so pinning
-- `public` alone would make the function fail at runtime on Supabase even
-- though it created cleanly.
SET search_path = public, extensions
AS $$
DECLARE
  candidate JSONB;
  mention JSONB;
  candidate_embedding vector(1536);
  resolved_id UUID;
  created INTEGER := 0;
  matched_exact INTEGER := 0;
  matched_semantic INTEGER := 0;
  embeddings_backfilled INTEGER := 0;
  mentions_written INTEGER := 0;
  encounters_recorded INTEGER := 0;
  inserted INTEGER;
  foreign_chunks INTEGER;
  encounter_time TIMESTAMPTZ;
  document_title TEXT;
  projections JSONB;
BEGIN
  -- Ownership check and encounter time in one read. Taking the timestamp from
  -- the document rather than a parameter means a caller cannot supply a wrong
  -- one, and re-ingest always recomputes the same value.
  SELECT d.created_at, d.title
  INTO encounter_time, document_title
  FROM public.documents d
  WHERE d.id = target_document_id AND d.user_id = target_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % does not belong to user %', target_document_id, target_user_id;
  END IF;

  IF candidates IS NULL OR jsonb_typeof(candidates) <> 'array' THEN
    RAISE EXCEPTION 'candidates must be a JSON array';
  END IF;

  -- Every mention must land on a chunk of THIS document. The foreign key alone
  -- only proves the chunk exists, so without this a malformed payload could
  -- attach one user's mention to another user's chunk while carrying this
  -- user's id -- an integrity hole in a SECURITY DEFINER function.
  SELECT COUNT(*) INTO foreign_chunks
  FROM (
    SELECT DISTINCT (m->>'chunkId')::UUID AS chunk_id
    FROM jsonb_array_elements(candidates) AS c
    CROSS JOIN LATERAL jsonb_array_elements(c->'mentions') AS m
  ) requested
  LEFT JOIN public.document_chunks dc
    ON dc.id = requested.chunk_id
   AND dc.document_id = target_document_id
  WHERE dc.id IS NULL;

  IF foreign_chunks > 0 THEN
    RAISE EXCEPTION 'Mentions reference % chunk(s) outside document %',
      foreign_chunks, target_document_id;
  END IF;

  DELETE FROM public.concept_mentions WHERE document_id = target_document_id;

  FOR candidate IN SELECT * FROM jsonb_array_elements(candidates)
  LOOP
    candidate_embedding := public.jsonb_to_vector(candidate->'embedding');
    resolved_id := NULL;

    SELECT c.id INTO resolved_id
    FROM public.concepts c
    WHERE c.user_id = target_user_id
      AND c.canonical_key = candidate->>'canonicalKey';

    IF resolved_id IS NOT NULL THEN
      matched_exact := matched_exact + 1;
    ELSIF candidate_embedding IS NOT NULL THEN
      -- Exact nearest-neighbour scan over this user's concepts only. See the
      -- index note above: approximate search here would silently miss matches
      -- across tenants and manufacture duplicates.
      SELECT c.id INTO resolved_id
      FROM public.concepts c
      WHERE c.user_id = target_user_id
        AND c.embedding IS NOT NULL
        AND 1 - (c.embedding <=> candidate_embedding) >= similarity_threshold
      ORDER BY c.embedding <=> candidate_embedding
      LIMIT 1;

      IF resolved_id IS NOT NULL THEN
        matched_semantic := matched_semantic + 1;
      END IF;
    END IF;

    IF resolved_id IS NULL THEN
      INSERT INTO public.concepts (user_id, label, canonical_key, embedding, embedding_model)
      VALUES (
        target_user_id,
        candidate->>'label',
        candidate->>'canonicalKey',
        candidate_embedding,
        candidate->>'embeddingModel'
      )
      RETURNING id INTO resolved_id;
      created := created + 1;
    ELSIF candidate_embedding IS NOT NULL THEN
      -- A concept created while embedding was unavailable would otherwise stay
      -- unembedded forever, invisible to deduplication and to any later
      -- similarity query, with no way to tell which rows are affected.
      UPDATE public.concepts
      SET embedding = candidate_embedding,
          embedding_model = candidate->>'embeddingModel'
      WHERE id = resolved_id AND embedding IS NULL;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      embeddings_backfilled := embeddings_backfilled + inserted;
    END IF;

    FOR mention IN SELECT * FROM jsonb_array_elements(candidate->'mentions')
    LOOP
      INSERT INTO public.concept_mentions (
        user_id, concept_id, document_id, chunk_id,
        surface_form, char_start, char_end, page_start, page_end, encountered_at
      )
      VALUES (
        target_user_id,
        resolved_id,
        target_document_id,
        (mention->>'chunkId')::UUID,
        mention->>'surfaceForm',
        (mention->>'charStart')::INTEGER,
        (mention->>'charEnd')::INTEGER,
        (mention->>'pageStart')::INTEGER,
        (mention->>'pageEnd')::INTEGER,
        encounter_time
      )
      ON CONFLICT (chunk_id, concept_id, char_start) DO NOTHING;

      GET DIAGNOSTICS inserted = ROW_COUNT;
      mentions_written := mentions_written + inserted;
    END LOOP;
  END LOOP;

  -- One immutable encounter per concept per document, written in the same
  -- transaction as the mentions it summarises. Emitting this from application
  -- code would risk losing an encounter permanently if the worker died in
  -- between, and an encounter that was never recorded cannot be reconstructed.
  --
  -- The dedupe key uses the canonical key rather than the concept id: a concept
  -- pruned and later recreated gets a new id, and keying on it would emit a
  -- second encounter for material the user met once.
  WITH encounters AS (
    SELECT m.concept_id, COUNT(*)::INTEGER AS mention_count
    FROM public.concept_mentions m
    WHERE m.document_id = target_document_id
    GROUP BY m.concept_id
  )
  INSERT INTO public.observations (
    user_id, event_type, event_category, actor, source_type, source_id,
    occurred_at, context, payload, dedupe_key
  )
  SELECT
    target_user_id,
    'concept_encountered',
    'document',
    'system',
    'concept',
    c.id,
    encounter_time,
    jsonb_build_object('documentId', target_document_id),
    jsonb_build_object(
      'label', c.label,
      'canonicalKey', c.canonical_key,
      'documentTitle', document_title,
      'mentionCount', e.mention_count
    ),
    'concept_encountered:' || target_document_id::TEXT || ':' || c.canonical_key
  FROM encounters e
  JOIN public.concepts c ON c.id = e.concept_id
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS encounters_recorded = ROW_COUNT;

  projections := public.rebuild_concept_projections(target_user_id);

  RETURN jsonb_build_object(
    'conceptsCreated', created,
    'conceptsMatchedExact', matched_exact,
    'conceptsMatchedSemantic', matched_semantic,
    'embeddingsBackfilled', embeddings_backfilled,
    'mentionsWritten', mentions_written,
    'encountersRecorded', encounters_recorded,
    'prunedConcepts', projections->'prunedConcepts',
    'edges', projections->'edges'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_document_concepts(UUID, UUID, JSONB, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_document_concepts(UUID, UUID, JSONB, DOUBLE PRECISION) TO service_role;

-- Repairs timestamps written by the previous logic on any existing data.
DO $$
DECLARE
  affected_user UUID;
BEGIN
  FOR affected_user IN SELECT DISTINCT user_id FROM public.concepts
  LOOP
    PERFORM public.rebuild_concept_projections(affected_user);
  END LOOP;
END;
$$;
