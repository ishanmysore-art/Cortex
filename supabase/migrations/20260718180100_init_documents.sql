-- Create custom types for document status and file type
CREATE TYPE document_status AS ENUM ('pending', 'processing', 'ready', 'failed');
CREATE TYPE document_file_type AS ENUM ('markdown', 'pdf', 'text');

-- Documents table
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_type document_file_type NOT NULL,
    status document_status NOT NULL DEFAULT 'pending',
    file_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- RLS Policies for documents
CREATE POLICY "Users can view their own documents" 
ON public.documents FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own documents" 
ON public.documents FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own documents" 
ON public.documents FOR UPDATE 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own documents" 
ON public.documents FOR DELETE 
USING (auth.uid() = user_id);

-- Document chunks table (prepared for pgvector later)
CREATE TABLE IF NOT EXISTS public.document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- We will add an 'embedding' column in Milestone 5
);

-- Enable RLS for chunks
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

-- RLS Policies for chunks (users can manage chunks via their documents)
CREATE POLICY "Users can view chunks for their documents" 
ON public.document_chunks FOR SELECT 
USING (
    EXISTS (
        SELECT 1 FROM public.documents 
        WHERE documents.id = document_chunks.document_id 
        AND documents.user_id = auth.uid()
    )
);

CREATE POLICY "Users can insert chunks for their documents" 
ON public.document_chunks FOR INSERT 
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.documents 
        WHERE documents.id = document_chunks.document_id 
        AND documents.user_id = auth.uid()
    )
);

CREATE POLICY "Users can delete chunks for their documents" 
ON public.document_chunks FOR DELETE 
USING (
    EXISTS (
        SELECT 1 FROM public.documents 
        WHERE documents.id = document_chunks.document_id 
        AND documents.user_id = auth.uid()
    )
);

-- Supabase Storage bucket for documents
INSERT INTO storage.buckets (id, name, public) 
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS Policies
CREATE POLICY "Users can upload to their own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'documents' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can view their own documents"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'documents' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can delete their own documents"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'documents' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);
