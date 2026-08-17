-- Close the `documents` write surface on system-owned columns.
--
-- What the gap actually allowed: NOT a cross-user update. The existing UPDATE
-- policy carries both USING and WITH CHECK on `auth.uid() = user_id`, so another
-- user's row is untouchable and ownership cannot be reassigned. The hole was
-- column-level and self-inflicted: the owner of a document could set its own
-- `status` to 'ready' on something that never ingested, clear a real
-- `extraction_error`, or rewrite `processed_at`, `content_hash`,
-- `embedding_model`, and `file_path`.
--
-- Those columns are derived state. Every legitimate write to them comes from the
-- service-role ingestion worker or a SECURITY DEFINER function, never from a
-- user-scoped client, so no application behaviour depends on this privilege.
--
-- RLS is the wrong tool for the job: a policy's WITH CHECK cannot reference the
-- old row, so it cannot express "you may not change this column". Column-level
-- privileges can. A table-level grant cannot be partially revoked, so the grant
-- is withdrawn and re-issued for exactly the column a user has any business
-- editing.

REVOKE UPDATE ON public.documents FROM authenticated;
REVOKE UPDATE ON public.documents FROM anon;

-- Renaming a document is a plausible user action and touches nothing derived.
GRANT UPDATE (title) ON public.documents TO authenticated;

COMMENT ON POLICY "Users can update their own documents" ON public.documents IS
  'Restricts UPDATE to rows the caller owns. Which columns they may write is governed separately by column-level grants: only `title`.';
