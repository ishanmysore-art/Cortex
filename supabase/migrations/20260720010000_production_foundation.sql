-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Production foundations for ingestion, grounded chat, citations, and memory.

-- Keep document state explicit and queryable. Defaults make this safe for existing rows.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS extraction_error TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS token_count INTEGER,
  ADD COLUMN IF NOT EXISTS char_start INTEGER,
  ADD COLUMN IF NOT EXISTS char_end INTEGER,
  ADD COLUMN IF NOT EXISTS page_start INTEGER,
  ADD COLUMN IF NOT EXISTS page_end INTEGER,
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small';

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_document_chunk_index_key
  ON public.document_chunks (document_id, chunk_index);

CREATE INDEX IF NOT EXISTS documents_user_created_at_idx
  ON public.documents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx
  ON public.document_chunks (document_id, chunk_index);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TYPE ingestion_job_status AS ENUM ('queued', 'processing', 'completed', 'failed', 'retry');
CREATE TYPE conversation_message_role AS ENUM ('user', 'assistant');
CREATE TYPE memory_status AS ENUM ('active', 'archived', 'rejected');

CREATE TABLE public.ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  status ingestion_job_status NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ingestion_jobs_active_document_key
  ON public.ingestion_jobs (document_id)
  WHERE status IN ('queued', 'processing', 'retry');
CREATE INDEX ingestion_jobs_claim_idx
  ON public.ingestion_jobs (status, run_after, created_at)
  WHERE status IN ('queued', 'retry');

ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own ingestion jobs"
ON public.ingestion_jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can enqueue their own ingestion jobs"
ON public.ingestion_jobs FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = document_id AND d.user_id = auth.uid()
  )
);
CREATE POLICY "Users can delete their own ingestion jobs"
ON public.ingestion_jobs FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER ingestion_jobs_set_updated_at
BEFORE UPDATE ON public.ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- This function is callable only by the service role used by the internal worker.
CREATE OR REPLACE FUNCTION public.claim_ingestion_jobs(worker_name TEXT, batch_size INTEGER DEFAULT 1)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.ingestion_jobs
    WHERE status IN ('queued', 'retry')
      AND run_after <= NOW()
      AND attempts < max_attempts
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(batch_size, 1), 10)
  )
  UPDATE public.ingestion_jobs AS job
  SET status = 'processing',
      attempts = job.attempts + 1,
      locked_at = NOW(),
      locked_by = worker_name,
      updated_at = NOW()
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_ingestion_jobs(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_jobs(TEXT, INTEGER) TO service_role;

CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX conversations_user_updated_idx ON public.conversations (user_id, updated_at DESC);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own conversations"
ON public.conversations FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role conversation_message_role NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming', 'completed', 'failed')),
  model TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX messages_conversation_created_idx ON public.messages (conversation_id, created_at);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage messages for their conversations"
ON public.messages FOR ALL
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = messages.conversation_id AND c.user_id = auth.uid()
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = messages.conversation_id AND c.user_id = auth.uid()
));

CREATE TABLE public.message_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  citation_index INTEGER NOT NULL CHECK (citation_index > 0),
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  chunk_id UUID REFERENCES public.document_chunks(id) ON DELETE SET NULL,
  document_title_snapshot TEXT NOT NULL,
  excerpt_snapshot TEXT NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, citation_index)
);
ALTER TABLE public.message_citations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view citations for their messages"
ON public.message_citations FOR SELECT
USING (EXISTS (
  SELECT 1
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.id = message_citations.message_id AND c.user_id = auth.uid()
));
CREATE POLICY "Users can add citations for their messages"
ON public.message_citations FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.id = message_citations.message_id AND c.user_id = auth.uid()
));

CREATE TABLE public.memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  status memory_status NOT NULL DEFAULT 'active',
  source_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX memories_user_status_idx ON public.memories (user_id, status, updated_at DESC);
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own memories"
ON public.memories FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER memories_set_updated_at
BEFORE UPDATE ON public.memories
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_usage_events_user_created_idx ON public.ai_usage_events (user_id, created_at DESC);
ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own AI usage"
ON public.ai_usage_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can record their own AI usage"
ON public.ai_usage_events FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.rate_limit_buckets (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, operation)
);
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_rate_limit(operation_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
  request_limit INTEGER;
  accepted BOOLEAN := FALSE;
BEGIN
  IF current_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  request_limit := CASE operation_name
    WHEN 'ask' THEN 30
    WHEN 'search' THEN 60
    WHEN 'upload' THEN 10
    WHEN 'memory' THEN 30
    ELSE 0
  END;

  IF request_limit = 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.rate_limit_buckets (user_id, operation, window_started_at, request_count)
  VALUES (current_user_id, operation_name, NOW(), 1)
  ON CONFLICT (user_id, operation) DO UPDATE
    SET window_started_at = CASE
          WHEN public.rate_limit_buckets.window_started_at <= NOW() - INTERVAL '1 minute' THEN NOW()
          ELSE public.rate_limit_buckets.window_started_at
        END,
        request_count = CASE
          WHEN public.rate_limit_buckets.window_started_at <= NOW() - INTERVAL '1 minute' THEN 1
          ELSE public.rate_limit_buckets.request_count + 1
        END
    WHERE public.rate_limit_buckets.window_started_at <= NOW() - INTERVAL '1 minute'
       OR public.rate_limit_buckets.request_count < request_limit
  RETURNING TRUE INTO accepted;

  RETURN COALESCE(accepted, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT) TO authenticated;

-- Return source metadata in the retrieval contract and avoid incomplete documents.
-- PostgreSQL cannot alter a RETURNS TABLE shape with CREATE OR REPLACE.
-- Drop the former five-column RPC before creating the expanded contract.
DROP FUNCTION IF EXISTS public.match_document_chunks(vector, double precision, integer);
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  similarity float,
  document_title text,
  document_file_type document_file_type,
  page_start integer,
  page_end integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    d.title,
    d.file_type,
    dc.page_start,
    dc.page_end
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE d.user_id = auth.uid()
    AND d.status = 'ready'
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> query_embedding) > LEAST(GREATEST(match_threshold, 0), 1)
  ORDER BY dc.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 20);
$$;
