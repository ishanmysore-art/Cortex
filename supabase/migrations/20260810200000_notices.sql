-- Milestone 6: proactive notices, response loop first.
--
-- The detectors here are the easy part -- every one is a query over projections
-- that already exist. The part that cannot be added later is the RESPONSE: a
-- notice the user dismisses is the only honest signal that Cortex was wrong,
-- and like every other signal in this architecture, an interaction that was
-- never recorded is gone permanently. So the loop is built first and the
-- detectors are deliberately few and conservative.
--
-- Nothing here surfaces autonomously. Notices are detected when the evidence
-- behind them changes and are shown only when the user opens the page. There is
-- no push, no email, and no notification.
--
-- Both detectors report COUNTS. Neither judges what the user knows: a
-- "knowledge gap" notice would be exactly the mastery inference Milestone 4
-- ruled out, and nothing in the log distinguishes a citation that helped from
-- one that did not.

CREATE TYPE notice_response AS ENUM ('pending', 'accepted', 'dismissed');

CREATE TABLE public.notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Owned by lib/notices/types.ts, for the same reason as observation event
  -- types: adding a detector should be a typed code change, not an ALTER TYPE.
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 32),

  -- What the notice is about, built from canonical keys and NEVER from row ids.
  -- A concept pruned and recreated gets a new id; keying on that would let a
  -- dismissed notice come back. This column plus the unique constraint below
  -- IS the suppression mechanism -- there is no separate rejection table.
  subject_key TEXT NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 300),

  -- Snapshot of the counts that produced it, so the notice stays readable after
  -- the concepts or documents behind it are gone.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- An inspectable sentence built from the evidence, same discipline as an
  -- inferred claim's. Never an opaque score.
  confidence_method TEXT NOT NULL CHECK (char_length(confidence_method) BETWEEN 1 AND 500),

  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  surfaced_at TIMESTAMPTZ,
  response notice_response NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,

  CONSTRAINT notices_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT notices_payload_size CHECK (octet_length(payload::text) <= 4000),
  CONSTRAINT notices_response_timed
    CHECK (response = 'pending' OR responded_at IS NOT NULL),
  UNIQUE (user_id, kind, subject_key)
);

CREATE INDEX notices_user_response_idx
  ON public.notices (user_id, response, detected_at DESC);
CREATE INDEX notices_user_pending_idx
  ON public.notices (user_id, surfaced_at)
  WHERE response = 'pending';

-- Read-only to clients, enforced twice: RLS scopes which rows are visible, and
-- withdrawing write privileges means a client cannot forge or edit one.
ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own notices"
ON public.notices FOR SELECT USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.notices FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.notices FROM anon;

COMMENT ON TABLE public.notices IS
  'Things Cortex noticed, with the counts behind them. Suppression is the unique (user_id, kind, subject_key) constraint: a dismissed notice can never be recreated.';
COMMENT ON COLUMN public.notices.subject_key IS
  'Durable identity from canonical keys, never row ids, so a dismissal survives a concept being pruned and recreated.';

-- ---------------------------------------------------------------------------
-- Detection
-- ---------------------------------------------------------------------------

/**
 * Runs every detector for one user.
 *
 * `ON CONFLICT DO NOTHING` on a dismissed or accepted notice is what makes a
 * dismissal permanent. A still-pending notice has its counts refreshed, since
 * showing stale numbers on something the user has not yet seen helps nobody.
 */
CREATE OR REPLACE FUNCTION public.detect_notices(
  target_user_id UUID,
  min_shared_passages INTEGER DEFAULT 3,
  min_shared_documents INTEGER DEFAULT 2,
  min_recurring_documents INTEGER DEFAULT 3,
  min_recurring_span_days INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  connections INTEGER := 0;
  recurring INTEGER := 0;
BEGIN
  IF target_user_id IS NULL THEN
    RETURN jsonb_build_object('connections', 0, 'recurring', 0);
  END IF;

  -- Detector 1: two ideas that keep turning up together, across separate
  -- documents. Counted co-occurrence from `concept_edges`; it reports that they
  -- co-occur, not that they are related.
  WITH pairs AS (
    SELECT
      CASE WHEN cf.canonical_key <= ct.canonical_key THEN cf.canonical_key ELSE ct.canonical_key END AS key_a,
      CASE WHEN cf.canonical_key <= ct.canonical_key THEN ct.canonical_key ELSE cf.canonical_key END AS key_b,
      CASE WHEN cf.canonical_key <= ct.canonical_key THEN cf.label ELSE ct.label END AS label_a,
      CASE WHEN cf.canonical_key <= ct.canonical_key THEN ct.label ELSE cf.label END AS label_b,
      e.evidence_count,
      e.document_count
    FROM public.concept_edges e
    JOIN public.concepts cf ON cf.id = e.from_concept_id
    JOIN public.concepts ct ON ct.id = e.to_concept_id
    WHERE e.user_id = target_user_id
      AND e.evidence_count >= min_shared_passages
      AND e.document_count >= min_shared_documents
  )
  INSERT INTO public.notices (user_id, kind, subject_key, payload, confidence_method)
  SELECT
    target_user_id,
    'concept_connection',
    left('concept_connection:' || p.key_a || '|' || p.key_b, 300),
    jsonb_build_object(
      'labelA', p.label_a,
      'labelB', p.label_b,
      'passageCount', p.evidence_count,
      'documentCount', p.document_count
    ),
    format(
      '"%s" and "%s" appear together in %s passages across %s of your documents',
      p.label_a, p.label_b, p.evidence_count, p.document_count
    )
  FROM pairs p
  ON CONFLICT (user_id, kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        confidence_method = EXCLUDED.confidence_method,
        detected_at = NOW()
    WHERE public.notices.response = 'pending';
  GET DIAGNOSTICS connections = ROW_COUNT;

  -- Detector 2: an idea the user keeps meeting across separate documents over a
  -- sustained period. Counts and dates only -- it says nothing about whether
  -- they know it.
  INSERT INTO public.notices (user_id, kind, subject_key, payload, confidence_method)
  SELECT
    target_user_id,
    'recurring_concept',
    left('recurring_concept:' || c.canonical_key, 300),
    jsonb_build_object(
      'label', c.label,
      'canonicalKey', c.canonical_key,
      'documentCount', k.encounter_document_count,
      'encounterCount', k.encounter_count,
      'firstEncounteredAt', k.first_encountered_at,
      'lastEncounteredAt', k.last_encountered_at
    ),
    format(
      '"%s" appears in %s of your documents, first on %s and most recently on %s',
      c.label,
      k.encounter_document_count,
      to_char(k.first_encountered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      to_char(k.last_encountered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    )
  FROM public.knowledge_states k
  JOIN public.concepts c ON c.id = k.concept_id
  WHERE k.user_id = target_user_id
    AND k.encounter_document_count >= min_recurring_documents
    AND k.first_encountered_at IS NOT NULL
    AND k.last_encountered_at IS NOT NULL
    AND k.last_encountered_at - k.first_encountered_at
        >= make_interval(days => min_recurring_span_days)
  ON CONFLICT (user_id, kind, subject_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        confidence_method = EXCLUDED.confidence_method,
        detected_at = NOW()
    WHERE public.notices.response = 'pending';
  GET DIAGNOSTICS recurring = ROW_COUNT;

  RETURN jsonb_build_object('connections', connections, 'recurring', recurring);
END;
$$;

REVOKE ALL ON FUNCTION public.detect_notices(UUID, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_notices(UUID, INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;

/** Runs detection for the caller only. */
CREATE OR REPLACE FUNCTION public.refresh_my_notices()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RETURN jsonb_build_object('connections', 0, 'recurring', 0);
  END IF;
  RETURN public.detect_notices(current_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_my_notices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_my_notices() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The response loop
-- ---------------------------------------------------------------------------

/**
 * Records that pending notices were actually shown to the user.
 *
 * Separate from detection because they are different events: a notice can sit
 * detected for days before anyone looks at it, and "Cortex noticed this" is not
 * the same fact as "the user saw it". Without the distinction, a dismissal rate
 * would be uninterpretable.
 */
CREATE OR REPLACE FUNCTION public.mark_my_notices_surfaced()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
  surfaced INTEGER := 0;
BEGIN
  IF current_user_id IS NULL THEN RETURN 0; END IF;

  WITH newly AS (
    UPDATE public.notices
    SET surfaced_at = NOW()
    WHERE user_id = current_user_id
      AND response = 'pending'
      AND surfaced_at IS NULL
    RETURNING id, kind, subject_key
  )
  INSERT INTO public.observations (
    user_id, event_type, event_category, actor, source_type, source_id,
    occurred_at, context, payload, dedupe_key
  )
  SELECT
    current_user_id, 'notice_surfaced', 'interaction', 'cortex', 'notice', n.id,
    NOW(), '{}'::jsonb,
    jsonb_build_object('kind', n.kind, 'subjectKey', n.subject_key),
    'notice_surfaced:' || n.id::TEXT
  FROM newly n
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;

  GET DIAGNOSTICS surfaced = ROW_COUNT;
  RETURN surfaced;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_my_notices_surfaced() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_my_notices_surfaced() TO authenticated;

/**
 * Records the user's response, which is the entire point of this milestone.
 *
 * A dismissal is permanent: the unique constraint on (kind, subject_key) means
 * detection can never recreate it. That is deliberate -- re-offering something
 * a person has already rejected is how a proactive feature burns trust.
 */
CREATE OR REPLACE FUNCTION public.respond_to_notice(
  target_notice_id UUID,
  new_response TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
  notice RECORD;
  updated INTEGER := 0;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF new_response NOT IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'Unsupported notice response %', new_response;
  END IF;

  UPDATE public.notices
  SET response = new_response::notice_response,
      responded_at = NOW(),
      -- Responding to something implies having seen it, even if the surfacing
      -- pass had not run yet.
      surfaced_at = COALESCE(surfaced_at, NOW())
  WHERE id = target_notice_id AND user_id = current_user_id
  RETURNING id, kind, subject_key INTO notice;
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated = 0 THEN
    RETURN jsonb_build_object('updated', 0);
  END IF;

  INSERT INTO public.observations (
    user_id, event_type, event_category, actor, source_type, source_id,
    occurred_at, context, payload, dedupe_key
  )
  VALUES (
    current_user_id,
    CASE new_response WHEN 'accepted' THEN 'notice_accepted' ELSE 'notice_dismissed' END,
    'explicit_signal', 'user', 'notice', notice.id, NOW(), '{}'::jsonb,
    jsonb_build_object('kind', notice.kind, 'subjectKey', notice.subject_key),
    'notice_' || new_response || ':' || notice.id::TEXT
  )
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('updated', updated);
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_notice(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_notice(UUID, TEXT) TO authenticated;
