-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Milestone 2: the concept layer.
--
-- Concepts are the join key between what a user has read and what later
-- milestones will model about them. Three rules shape this schema:
--
--   1. A concept may not exist without at least one mention. A concept with no
--      source span is an unfalsifiable assertion, which is what this whole
--      architecture exists to avoid.
--   2. A mention points at a verifiable span of stored chunk text, so any
--      concept can be checked against the words that produced it.
--   3. Edges are counted co-occurrence, never an asserted semantic relation.
--      "These two appear together in 7 passages" is a fact. "A is a kind of B"
--      would be a model opinion, and there is no grounding method for it yet.
--
-- Unlike `observations`, everything here is DERIVED state: it is rebuildable
-- from documents and chunks, so cascading deletes are correct and expected.

CREATE TABLE public.concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Display form: the canonical name the extractor settled on ("working memory",
  -- "attention deficit hyperactivity disorder"), not the surface form found in
  -- the text. Surface forms are preserved per mention.
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),

  -- Deterministic normalisation of `label`, and the concept's identity. The
  -- unique constraint below is the hard guarantee against duplicates.
  canonical_key TEXT NOT NULL CHECK (char_length(canonical_key) BETWEEN 1 AND 120),

  embedding vector(1536),
  embedding_model TEXT,

  -- Derived counters, refreshed by `rebuild_concept_projections`.
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  document_count INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, canonical_key)
);

CREATE INDEX concepts_user_last_seen_idx ON public.concepts (user_id, last_seen_at DESC);
CREATE INDEX concepts_user_mentions_idx ON public.concepts (user_id, mention_count DESC);
CREATE INDEX concepts_embedding_idx
  ON public.concepts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE public.concept_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL REFERENCES public.document_chunks(id) ON DELETE CASCADE,

  -- What actually appeared in the text. Keeping it makes canonicalisation
  -- lossless: "ADHD" resolving to the expanded concept name is still
  -- recoverable as the words on the page.
  surface_form TEXT NOT NULL CHECK (char_length(surface_form) BETWEEN 1 AND 200),

  -- Offsets are relative to `document_chunks.content`, NOT to the original
  -- document. The chunker prefixes each chunk with an overlap carry, so a
  -- document-absolute offset would not survive verification. Chunk-relative
  -- offsets are exactly checkable:
  --   substring(content FROM char_start + 1 FOR char_end - char_start) = surface_form
  char_start INTEGER NOT NULL CHECK (char_start >= 0),
  char_end INTEGER NOT NULL,

  -- Denormalised from the chunk so a mention is directly citable.
  page_start INTEGER,
  page_end INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT concept_mentions_span_valid CHECK (char_end > char_start),
  -- One concept cannot be mentioned twice at the same position.
  UNIQUE (chunk_id, concept_id, char_start)
);

CREATE INDEX concept_mentions_concept_idx ON public.concept_mentions (concept_id, created_at DESC);
CREATE INDEX concept_mentions_document_idx ON public.concept_mentions (document_id);
CREATE INDEX concept_mentions_user_idx ON public.concept_mentions (user_id);
CREATE INDEX concept_mentions_chunk_idx ON public.concept_mentions (chunk_id);

CREATE TABLE public.concept_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  to_concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,

  -- Only 'co_occurs_with' is produced today. The column exists so a typed
  -- relation can be added once there is a grounding method for it, not as an
  -- invitation to invent an ontology.
  relation TEXT NOT NULL DEFAULT 'co_occurs_with',

  -- Distinct chunks in which both concepts appear. This is a count of evidence,
  -- not a model-assigned strength.
  evidence_count INTEGER NOT NULL CHECK (evidence_count > 0),
  document_count INTEGER NOT NULL CHECK (document_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The relation is undirected, so the pair is stored in a canonical order.
  -- This makes A–B and B–A the same row rather than two contradictory ones.
  CONSTRAINT concept_edges_canonical_order CHECK (from_concept_id < to_concept_id),
  UNIQUE (from_concept_id, to_concept_id, relation)
);

CREATE INDEX concept_edges_user_evidence_idx
  ON public.concept_edges (user_id, evidence_count DESC);
CREATE INDEX concept_edges_to_concept_idx ON public.concept_edges (to_concept_id);

-- Read-only for the owner. Every write goes through the SECURITY DEFINER
-- functions below, so derived state cannot be forged or edited by a client.
-- No erasure policy is needed: deleting a document removes its chunks, which
-- removes its mentions, which orphans and prunes the concept.
ALTER TABLE public.concepts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own concepts"
ON public.concepts FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.concept_mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own concept mentions"
ON public.concept_mentions FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.concept_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own concept edges"
ON public.concept_edges FOR SELECT USING (auth.uid() = user_id);

-- A view rather than a query so the grouping lives in one place.
-- `security_invoker` makes the base tables' RLS apply to the querying user;
-- without it a view would run with the owner's rights and leak across users.
CREATE VIEW public.document_concepts WITH (security_invoker = true) AS
SELECT
  m.user_id,
  m.document_id,
  m.concept_id,
  c.label,
  c.canonical_key,
  COUNT(*)::INTEGER AS mention_count,
  MIN(m.page_start) AS first_page
FROM public.concept_mentions m
JOIN public.concepts c ON c.id = m.concept_id
GROUP BY m.user_id, m.document_id, m.concept_id, c.label, c.canonical_key;

GRANT SELECT ON public.document_concepts TO authenticated;

-- Parses a JSON number array into a vector. Building the literal explicitly
-- avoids relying on jsonb's text rendering being accepted by pgvector's parser.
CREATE OR REPLACE FUNCTION public.jsonb_to_vector(value JSONB)
RETURNS vector
LANGUAGE plpgsql
IMMUTABLE
-- `extensions` is on this function's search_path because it uses pgvector's
-- `<=>` operator and `vector` casts, which are resolved at execution time. A
-- SECURITY DEFINER `SET search_path` OVERRIDES the role default, so pinning
-- `public` alone would make the function fail at runtime on Supabase even
-- though it created cleanly.
SET search_path = public, extensions
AS $$
DECLARE
  literal TEXT;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT '[' || string_agg(element::TEXT, ',' ORDER BY ordinality) || ']'
  INTO literal
  FROM jsonb_array_elements(value) WITH ORDINALITY AS t(element, ordinality);

  RETURN literal::vector;
END;
$$;

/**
 * Recomputes every derived concept projection for one user.
 *
 * Counters, orphan pruning, and edges are all pure functions of
 * `concept_mentions`, so this can be run at any time and always converges to
 * the same answer. That is what keeps the hard rule -- no concept without a
 * mention -- true rather than merely intended.
 */
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
  UPDATE public.concepts c
  SET mention_count = s.mentions,
      document_count = s.documents,
      first_seen_at = LEAST(c.first_seen_at, s.first_mention),
      last_seen_at = GREATEST(c.last_seen_at, s.last_mention)
  FROM (
    SELECT concept_id,
           COUNT(*)::INTEGER AS mentions,
           COUNT(DISTINCT document_id)::INTEGER AS documents,
           MIN(created_at) AS first_mention,
           MAX(created_at) AS last_mention
    FROM public.concept_mentions
    WHERE user_id = target_user_id
    GROUP BY concept_id
  ) s
  WHERE c.id = s.concept_id;

  -- The hard rule, enforced. A concept whose last mention disappeared -- because
  -- its document was deleted or re-ingested without it -- is no longer traceable
  -- to anything and must not survive.
  DELETE FROM public.concepts c
  WHERE c.user_id = target_user_id
    AND NOT EXISTS (
      SELECT 1 FROM public.concept_mentions m WHERE m.concept_id = c.id
    );
  GET DIAGNOSTICS pruned = ROW_COUNT;

  -- Edges are a full recompute rather than an incremental update: incremental
  -- counting is not idempotent under re-ingest, and a personal knowledge base
  -- is small enough that correctness is worth more than the saved work.
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
   -- Strict ordering both deduplicates the undirected pair and satisfies
   -- `concept_edges_canonical_order`.
   AND b.concept_id > a.concept_id
  WHERE a.user_id = target_user_id
  GROUP BY a.concept_id, b.concept_id;
  GET DIAGNOSTICS edges = ROW_COUNT;

  RETURN jsonb_build_object('prunedConcepts', pruned, 'edges', edges);
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_concept_projections(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_concept_projections(UUID) TO service_role;

/**
 * Attaches one document's extracted concepts, atomically.
 *
 * Resolution order per candidate:
 *   1. exact canonical key  -- deterministic, the identity guarantee
 *   2. nearest embedding above `similarity_threshold` -- a deliberately
 *      conservative safety net for surface variants the normaliser cannot see
 *   3. create a new concept
 *
 * Step 2 only ever maps a NEW surface form onto an EXISTING concept. It never
 * merges two existing concepts, so a threshold that is too low costs a missed
 * split, never a destroyed distinction.
 */
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
  mentions_written INTEGER := 0;
  inserted INTEGER;
  projections JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = target_document_id AND d.user_id = target_user_id
  ) THEN
    RAISE EXCEPTION 'Document % does not belong to user %', target_document_id, target_user_id;
  END IF;

  IF candidates IS NULL OR jsonb_typeof(candidates) <> 'array' THEN
    RAISE EXCEPTION 'candidates must be a JSON array';
  END IF;

  -- Replacing this document's mentions wholesale makes re-ingest idempotent.
  -- Concept rows are deliberately NOT deleted here: their ids must stay stable
  -- across a re-ingest because later layers will hold them as foreign keys.
  -- Orphans are pruned at the end instead, once the new mentions exist.
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
    END IF;

    FOR mention IN SELECT * FROM jsonb_array_elements(candidate->'mentions')
    LOOP
      INSERT INTO public.concept_mentions (
        user_id, concept_id, document_id, chunk_id,
        surface_form, char_start, char_end, page_start, page_end
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
        (mention->>'pageEnd')::INTEGER
      )
      ON CONFLICT (chunk_id, concept_id, char_start) DO NOTHING;

      GET DIAGNOSTICS inserted = ROW_COUNT;
      mentions_written := mentions_written + inserted;
    END LOOP;
  END LOOP;

  projections := public.rebuild_concept_projections(target_user_id);

  RETURN jsonb_build_object(
    'conceptsCreated', created,
    'conceptsMatchedExact', matched_exact,
    'conceptsMatchedSemantic', matched_semantic,
    'mentionsWritten', mentions_written,
    'prunedConcepts', projections->'prunedConcepts',
    'edges', projections->'edges'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_document_concepts(UUID, UUID, JSONB, DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_document_concepts(UUID, UUID, JSONB, DOUBLE PRECISION) TO service_role;

/**
 * Reconciles the caller's concept projections after they delete a document.
 *
 * Deleting a document cascades to chunks and mentions but leaves counters stale
 * and can orphan concepts. Takes no user argument on purpose: it acts only on
 * `auth.uid()`, so an authenticated caller cannot reach another user's graph.
 */
CREATE OR REPLACE FUNCTION public.prune_orphan_concepts()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RETURN jsonb_build_object('prunedConcepts', 0, 'edges', 0);
  END IF;
  RETURN public.rebuild_concept_projections(current_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.prune_orphan_concepts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_orphan_concepts() TO authenticated;

COMMENT ON TABLE public.concepts IS
  'Canonical concepts derived from document text. Derived state: rebuildable from concept_mentions, and never valid without at least one mention.';
COMMENT ON COLUMN public.concept_mentions.char_start IS
  'Offset into document_chunks.content, not the source document. Verifiable against the stored chunk text.';
COMMENT ON TABLE public.concept_edges IS
  'Counted co-occurrence between concepts sharing a chunk. Evidence counts, never asserted semantic relations.';
