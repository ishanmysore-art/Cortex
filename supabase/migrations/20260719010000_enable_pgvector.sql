-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to document_chunks
ALTER TABLE public.document_chunks
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create HNSW index for fast nearest-neighbor search
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
ON public.document_chunks 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Create a function to search document chunks
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks dc
  -- Ensure users can only search chunks from their own documents
  JOIN public.documents d ON d.id = dc.document_id
  WHERE d.user_id = auth.uid()
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
