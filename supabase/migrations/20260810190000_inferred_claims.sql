-- Milestone 5: evidence-backed inference.
--
-- The first claims Cortex asserts itself. `user_claims` and `claim_evidence`
-- are reused unchanged in shape: M3 reserved `asserted_by='cortex'`, left
-- `confidence`/`confidence_method` writable, and made the evidence span columns
-- nullable precisely so this milestone would not need a parallel model.
--
-- An inferred claim is a SYNTHESIS OF WHAT THE USER ALREADY SAID -- never a
-- prediction of a latent attribute. The only rule implemented reads explicit
-- user claims and reports that they recur. It cannot see document content, so
-- the M3 boundary (reading about X is not believing X) holds automatically.
--
-- Standing prohibitions, restated because this is the milestone where they
-- matter most: no personality, learning-style, or psychological inference of any
-- kind; no mastery or forgetting score; no inference from a single observation;
-- no autonomous surfacing.

-- 'unsupported' is a system withdrawal: the evidence that justified an inference
-- fell below the bar it was created under. Distinct from 'retracted', which
-- means the user said it does not represent them.
ALTER TABLE public.user_claims
  DROP CONSTRAINT IF EXISTS user_claims_status_check;
ALTER TABLE public.user_claims
  ADD CONSTRAINT user_claims_status_check
  CHECK (status IN ('active', 'archived', 'retracted', 'superseded', 'unsupported'));

ALTER TABLE public.user_claims
  -- Which rule produced this, so a rule change is identifiable after the fact.
  ADD COLUMN IF NOT EXISTS inference_rule TEXT,
  -- The evidentiary bar this claim was created under. Stored per row so raising
  -- the threshold later does not retroactively invalidate existing claims.
  ADD COLUMN IF NOT EXISTS inference_min_evidence INTEGER
    CHECK (inference_min_evidence IS NULL OR inference_min_evidence >= 2);

COMMENT ON COLUMN public.user_claims.inference_min_evidence IS
  'Minimum evidence count that justified this inference. NULL for user-stated claims.';

CREATE INDEX IF NOT EXISTS user_claims_asserted_by_idx
  ON public.user_claims (user_id, asserted_by, status);

-- ---------------------------------------------------------------------------
-- Rejection outranks re-inference
-- ---------------------------------------------------------------------------

/**
 * A standing refusal of an inferred claim.
 *
 * Keyed on (claim_type, canonical_key) rather than claim id on purpose: deleting
 * the claim must not erase the refusal, or the next inference pass would simply
 * recreate what the user just rejected.
 */
CREATE TABLE public.claim_rejections (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'retracted' CHECK (reason IN ('retracted', 'archived')),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rejection_observation_id UUID REFERENCES public.observations(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, claim_type, canonical_key)
);

ALTER TABLE public.claim_rejections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own claim rejections"
ON public.claim_rejections FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.claim_rejections FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.claim_rejections FROM anon;

COMMENT ON TABLE public.claim_rejections IS
  'Standing user refusals of inferred claims. Checked before any re-inference writes.';

-- ---------------------------------------------------------------------------
-- Evidence removal re-evaluates an inference
-- ---------------------------------------------------------------------------

/**
 * Handles evidence removal in one place, in a fixed order.
 *
 * For a user-stated claim, one statement is enough, so losing a restatement
 * changes nothing. For an inferred claim the threshold IS the justification, so
 * falling below it withdraws the claim automatically rather than letting it
 * stand on evidence that no longer meets its own bar.
 *
 * The withdrawal is reversible: `unsupported` is a system state, and a later
 * inference pass with sufficient evidence reactivates the claim. Only a user
 * rejection is permanent.
 */
CREATE OR REPLACE FUNCTION public.handle_claim_evidence_removed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- 1. Counts first, so the checks below see the truth.
  UPDATE public.user_claims c
  SET evidence_count = (
    SELECT COUNT(*) FROM public.claim_evidence e WHERE e.claim_id = c.id
  )
  WHERE c.id IN (SELECT DISTINCT r.claim_id FROM removed_evidence r);

  -- 2. An inference below its own bar is no longer justified.
  UPDATE public.user_claims c
  SET status = 'unsupported',
      valid_to = NOW()
  WHERE c.id IN (SELECT DISTINCT r.claim_id FROM removed_evidence r)
    AND c.asserted_by = 'cortex'
    AND c.status = 'active'
    AND c.inference_min_evidence IS NOT NULL
    AND c.evidence_count < c.inference_min_evidence;

  -- 3. No evidence at all means no claim, inferred or stated.
  DELETE FROM public.user_claims c
  WHERE c.id IN (SELECT DISTINCT r.claim_id FROM removed_evidence r)
    AND NOT EXISTS (SELECT 1 FROM public.claim_evidence e WHERE e.claim_id = c.id);

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Correction records a standing refusal for inferred claims
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_user_claim(
  target_claim_id UUID,
  new_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
  claim RECORD;
  updated INTEGER;
  event TEXT;
  observation_id UUID;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF new_status NOT IN ('archived', 'retracted', 'active') THEN
    RAISE EXCEPTION 'Unsupported claim status %', new_status;
  END IF;

  SELECT c.id, c.claim_type, c.canonical_key, c.asserted_by
  INTO claim
  FROM public.user_claims c
  WHERE c.id = target_claim_id AND c.user_id = current_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', 0);
  END IF;

  UPDATE public.user_claims
  SET status = new_status,
      valid_to = CASE WHEN new_status = 'active' THEN NULL ELSE NOW() END
  WHERE id = target_claim_id AND user_id = current_user_id;
  GET DIAGNOSTICS updated = ROW_COUNT;

  event := CASE new_status
    WHEN 'archived' THEN 'claim_archived'
    WHEN 'retracted' THEN 'claim_retracted'
    ELSE 'claim_restored'
  END;

  INSERT INTO public.observations (
    user_id, event_type, event_category, actor, source_type, source_id,
    occurred_at, context, payload
  )
  VALUES (
    current_user_id, event, 'explicit_signal', 'user', 'claim', claim.id, NOW(),
    '{}'::jsonb,
    jsonb_build_object('claimType', claim.claim_type, 'canonicalKey', claim.canonical_key)
  )
  RETURNING id INTO observation_id;

  IF claim.asserted_by = 'cortex' THEN
    IF new_status = 'active' THEN
      -- Restoring withdraws the refusal, so inference may produce it again.
      DELETE FROM public.claim_rejections
      WHERE user_id = current_user_id
        AND claim_type = claim.claim_type
        AND canonical_key = claim.canonical_key;
    ELSE
      INSERT INTO public.claim_rejections (
        user_id, claim_type, canonical_key, reason, rejection_observation_id
      )
      VALUES (current_user_id, claim.claim_type, claim.canonical_key, new_status, observation_id)
      ON CONFLICT (user_id, claim_type, canonical_key) DO UPDATE
        SET reason = EXCLUDED.reason,
            rejected_at = NOW(),
            rejection_observation_id = EXCLUDED.rejection_observation_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('updated', updated);
END;
$$;

REVOKE ALL ON FUNCTION public.close_user_claim(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_user_claim(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- The inference rule
-- ---------------------------------------------------------------------------

/**
 * Infers `sustained_interest`: the user has repeatedly and independently stated
 * interest in, goals concerning, or questions about the same concept.
 *
 * Evidentiary bar, all required:
 *   - at least `min_claims` distinct explicit user claims naming the concept
 *   - across at least that many distinct messages, conversations, and calendar
 *     days -- so one sitting cannot manufacture an inference, and a restated
 *     claim (which M3 stores once with extra evidence) contributes once
 *   - spanning at least `min_span_days`
 *   - no contradicting user claim
 *
 * Only `claim_stated` observations are read, so document content can never
 * contribute: reading about X is still not believing X.
 *
 * Concept matching is exact whole-phrase containment against the concept's
 * canonical key or one of its recorded surface forms. There is no stemming, so
 * "transformers" does not match the concept "transformer". This under-matches by
 * design; a missed inference is recoverable, an invented one is not.
 */
CREATE OR REPLACE FUNCTION public.infer_sustained_interest(
  target_user_id UUID,
  min_claims INTEGER DEFAULT 3,
  min_span_days INTEGER DEFAULT 14
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rule CONSTANT TEXT := 'sustained_interest_v1';
  candidate RECORD;
  existing RECORD;
  resolved_claim_id UUID;
  statement_text TEXT;
  canonical TEXT;
  method TEXT;
  score NUMERIC;
  created INTEGER := 0;
  reactivated INTEGER := 0;
  refreshed INTEGER := 0;
  skipped_rejected INTEGER := 0;
  evidence_written INTEGER := 0;
  affected INTEGER;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  min_claims := GREATEST(min_claims, 2);

  FOR candidate IN
    WITH links AS (
      SELECT DISTINCT
        con.id AS concept_id,
        con.label,
        con.canonical_key AS concept_key,
        uc.id AS claim_id,
        ce.observation_id,
        ce.occurred_at,
        o.context->>'messageId' AS message_id,
        o.context->>'conversationId' AS conversation_id,
        (ce.occurred_at AT TIME ZONE 'UTC')::DATE AS stated_on
      FROM public.user_claims uc
      JOIN public.claim_evidence ce ON ce.claim_id = uc.id
      JOIN public.observations o ON o.id = ce.observation_id
      JOIN public.concepts con ON con.user_id = uc.user_id
      WHERE uc.user_id = target_user_id
        AND uc.asserted_by = 'user'
        AND uc.status = 'active'
        AND uc.claim_type IN ('interest', 'goal', 'open_question')
        AND o.event_type = 'claim_stated'
        AND (
          -- The claim names the concept by its canonical label...
          (' ' || uc.canonical_key || ' ') LIKE ('% ' || con.canonical_key || ' %')
          -- ...or by a form the user's own documents used for it, which is how
          -- "ADHD" reaches a concept labelled with the expanded name.
          OR EXISTS (
            SELECT 1
            FROM public.concept_mentions m
            WHERE m.concept_id = con.id
              AND char_length(
                trim(regexp_replace(lower(m.surface_form), '[^a-z0-9]+', ' ', 'g'))
              ) >= 3
              AND (' ' || uc.canonical_key || ' ') LIKE
                  ('% ' || trim(regexp_replace(lower(m.surface_form), '[^a-z0-9]+', ' ', 'g')) || ' %')
          )
        )
    ),
    contradicted AS (
      -- Any retracted claim naming the concept, or an active claim carrying an
      -- explicit reversal, disqualifies it. Cortex never overrides the user.
      SELECT DISTINCT con.id AS concept_id
      FROM public.user_claims uc
      JOIN public.concepts con ON con.user_id = uc.user_id
      WHERE uc.user_id = target_user_id
        AND uc.asserted_by = 'user'
        AND (' ' || uc.canonical_key || ' ') LIKE ('% ' || con.canonical_key || ' %')
        AND (
          uc.status = 'retracted'
          OR uc.canonical_key ~ '(^| )(no longer|not interested|stopped|gave up|moved away|dont want|do not want)( |$)'
        )
    )
    SELECT
      l.concept_id,
      l.label,
      l.concept_key,
      COUNT(DISTINCT l.claim_id) AS claim_count,
      COUNT(DISTINCT l.conversation_id) AS conversation_count,
      MIN(l.occurred_at) AS first_at,
      MAX(l.occurred_at) AS last_at,
      EXTRACT(DAY FROM MAX(l.occurred_at) - MIN(l.occurred_at))::INTEGER AS span_days,
      array_agg(DISTINCT l.observation_id) AS observation_ids
    FROM links l
    WHERE l.concept_id NOT IN (SELECT concept_id FROM contradicted)
    GROUP BY l.concept_id, l.label, l.concept_key
    HAVING COUNT(DISTINCT l.claim_id) >= min_claims
       -- Independence: distinct messages, conversations, and days. Several
       -- claims pulled from one message are one occasion, not three.
       AND COUNT(DISTINCT l.message_id) >= min_claims
       AND COUNT(DISTINCT l.conversation_id) >= min_claims
       AND COUNT(DISTINCT l.stated_on) >= min_claims
       AND MAX(l.occurred_at) - MIN(l.occurred_at) >= make_interval(days => min_span_days)
  LOOP
    canonical := left('sustained interest in ' || candidate.concept_key, 500);

    -- A standing refusal outranks any amount of fresh evidence.
    IF EXISTS (
      SELECT 1 FROM public.claim_rejections r
      WHERE r.user_id = target_user_id
        AND r.claim_type = 'sustained_interest'
        AND r.canonical_key = canonical
    ) THEN
      skipped_rejected := skipped_rejected + 1;
      CONTINUE;
    END IF;

    statement_text := left(
      format('User has repeatedly said they are working on or trying to understand %s.',
             candidate.label),
      500
    );

    -- Confidence is a published function of the evidence counts, not a model
    -- output, and is capped below certainty because this is an inference.
    score := LEAST(0.9, 0.5 + 0.1 * (candidate.claim_count - min_claims));

    method := format(
      '%s independent explicit claims naming "%s" across %s conversations over %s days (%s to %s); no contradicting claim',
      candidate.claim_count,
      candidate.label,
      candidate.conversation_count,
      candidate.span_days,
      to_char(candidate.first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      to_char(candidate.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    );

    SELECT c.id, c.status INTO existing
    FROM public.user_claims c
    WHERE c.user_id = target_user_id
      AND c.claim_type = 'sustained_interest'
      AND c.canonical_key = canonical;

    IF NOT FOUND THEN
      INSERT INTO public.user_claims (
        user_id, claim_type, asserted_by, statement, canonical_key,
        status, confidence, confidence_method, inference_rule, inference_min_evidence,
        valid_from, first_stated_at, last_stated_at
      )
      VALUES (
        target_user_id, 'sustained_interest', 'cortex', statement_text, canonical,
        'active', score, method, rule, min_claims,
        candidate.first_at, candidate.first_at, candidate.last_at
      )
      RETURNING id INTO resolved_claim_id;
      created := created + 1;
    ELSE
      resolved_claim_id := existing.id;
      -- A user-closed claim stays closed; only a system withdrawal reactivates.
      IF existing.status = 'unsupported' THEN
        UPDATE public.user_claims
        SET status = 'active', valid_to = NULL,
            confidence = score, confidence_method = method,
            last_stated_at = candidate.last_at
        WHERE id = resolved_claim_id;
        reactivated := reactivated + 1;
      ELSIF existing.status = 'active' THEN
        UPDATE public.user_claims
        SET confidence = score, confidence_method = method,
            last_stated_at = GREATEST(last_stated_at, candidate.last_at)
        WHERE id = resolved_claim_id;
        refreshed := refreshed + 1;
      ELSE
        CONTINUE;
      END IF;
    END IF;

    INSERT INTO public.claim_evidence (
      user_id, claim_id, observation_id, relation, occurred_at
    )
    SELECT target_user_id, resolved_claim_id, o.id, 'supports', o.occurred_at
    FROM public.observations o
    WHERE o.id = ANY (candidate.observation_ids)
    ON CONFLICT (claim_id, observation_id, relation) DO NOTHING;

    GET DIAGNOSTICS affected = ROW_COUNT;
    evidence_written := evidence_written + affected;
  END LOOP;

  RETURN jsonb_build_object(
    'rule', rule,
    'claimsCreated', created,
    'claimsReactivated', reactivated,
    'claimsRefreshed', refreshed,
    'skippedRejected', skipped_rejected,
    'evidenceWritten', evidence_written
  );
END;
$$;

REVOKE ALL ON FUNCTION public.infer_sustained_interest(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.infer_sustained_interest(UUID, INTEGER, INTEGER) TO service_role;

/** Runs inference for the caller only. */
CREATE OR REPLACE FUNCTION public.refresh_my_inferences()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id UUID := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RETURN jsonb_build_object('claimsCreated', 0);
  END IF;
  RETURN public.infer_sustained_interest(current_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_my_inferences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_my_inferences() TO authenticated, service_role;
