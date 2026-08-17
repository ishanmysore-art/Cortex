-- pgvector is installed into the `extensions` schema on Supabase, which is not
-- on the search_path that `supabase db push` runs migrations under. Without
-- this, `vector`, `vector_cosine_ops`, and the `<=>` operator all fail to
-- resolve with "type vector does not exist" (SQLSTATE 42704).
--
-- A schema listed in search_path that does not exist is silently ignored, so
-- this is equally correct where pgvector is installed into `public` instead.
SET search_path = public, extensions;

-- Update match_document_chunks RPC to allow candidate match limits up to 50
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
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;
