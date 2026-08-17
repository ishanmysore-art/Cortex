-- Recover ingestion jobs abandoned by a worker that stopped without releasing its lock.
--
-- `claim_ingestion_jobs` only ever claims 'queued' or 'retry'. Nothing reset
-- 'processing', and `ingestion_jobs_active_document_key` treats 'processing' as
-- an active job, so a worker that died mid-run left the job locked forever AND
-- blocked the document from ever being re-enqueued. This reclaims those jobs
-- while preserving the existing retry budget.

-- Keeps the reclaim scan off a sequential scan as the job table grows.
CREATE INDEX IF NOT EXISTS ingestion_jobs_stale_lock_idx
  ON public.ingestion_jobs (locked_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.reclaim_stale_ingestion_jobs(
  stale_after_seconds INTEGER DEFAULT 900,
  batch_size INTEGER DEFAULT 25
)
RETURNS TABLE (
  id UUID,
  document_id UUID,
  status ingestion_job_status,
  attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- A floor of 60s keeps a misconfigured caller from reclaiming jobs that are
  -- still legitimately running.
  cutoff TIMESTAMPTZ := NOW() - make_interval(secs => GREATEST(stale_after_seconds, 60));
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM public.ingestion_jobs job
    WHERE job.status = 'processing'
      AND job.locked_at IS NOT NULL
      AND job.locked_at < cutoff
    ORDER BY job.locked_at
    -- SKIP LOCKED means two concurrent reclaim passes can never take the same row.
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(batch_size, 1), 100)
  ),
  reclaimed AS (
    UPDATE public.ingestion_jobs AS job
    SET
      -- `claim_ingestion_jobs` already charged an attempt when it locked the
      -- job, so a reclaim never re-charges one: the retry budget is preserved
      -- exactly, and a job that crashes repeatedly still terminates.
      status = CASE
        WHEN job.attempts < job.max_attempts THEN 'retry'::ingestion_job_status
        ELSE 'failed'::ingestion_job_status
      END,
      run_after = NOW(),
      locked_at = NULL,
      locked_by = NULL,
      last_error = 'Processing was reclaimed after the worker stopped responding.',
      updated_at = NOW()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.id, job.document_id, job.status, job.attempts
  ),
  -- A data-modifying CTE always runs to completion even when the primary query
  -- does not read it, so the document state is resynced in the same transaction
  -- as the job state. The two can never disagree.
  synced_documents AS (
    UPDATE public.documents AS d
    SET
      status = CASE
        WHEN r.status = 'retry' THEN 'pending'::document_status
        ELSE 'failed'::document_status
      END,
      extraction_error = CASE
        WHEN r.status = 'retry' THEN NULL
        ELSE 'Processing stopped unexpectedly and exhausted every retry attempt.'
      END
    FROM reclaimed r
    WHERE d.id = r.document_id
    RETURNING d.id
  )
  SELECT r.id, r.document_id, r.status, r.attempts FROM reclaimed r;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_stale_ingestion_jobs(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_ingestion_jobs(INTEGER, INTEGER) TO service_role;

COMMENT ON FUNCTION public.reclaim_stale_ingestion_jobs(INTEGER, INTEGER) IS
  'Returns jobs stuck in ''processing'' past the staleness window to ''retry'' (or ''failed'' once the attempt budget is spent) and resyncs the owning document. Service role only.';
