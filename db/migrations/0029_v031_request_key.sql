-- Nyst v0.3.1 — issue 9. A PERSON IS NOT A REQUEST.
--
-- THE DEFECT.
--
--   outcome_offboarding_runs.subject_key text NOT NULL UNIQUE
--   nyst_outcome_instances  UNIQUE (environment_id, outcome_contract_id, subject_key)
--
-- subject_key identifies WHO something is about -- `offboard:alice@example.test`.
-- Making it unique turns a person's identity into a permanent idempotency key,
-- so Alice can be offboarded exactly once. Not once per request, not once at a
-- time: once, for the lifetime of the database.
--
-- Contractors who return, boomerang employees, seasonal staff and plain rehires
-- are ordinary. So is the simpler case: an offboarding that failed or was
-- cancelled could never be retried under a new request.
--
-- And the failure was quiet in the worst way. openInstance used
-- ON CONFLICT DO NOTHING and returned the existing row with created:false, so a
-- caller offboarding Alice in December received March's already-SATISFIED
-- instance, complete with its signed receipt. Every signal said the December
-- offboarding had succeeded before it started.
--
-- THE DISTINCTION.
--
--   subject_key  WHO this is about. Repeats, deliberately: "show me everything
--                Nyst has ever established about Alice" is a question worth
--                being able to ask.
--   request_key  THIS request. Unique among LIVE requests, so two concurrent
--                offboardings of one person still cannot race.
--
-- "At most one live request per subject" is a genuine safety property and is
-- kept. "At most one request per subject for all time" was never one; it was a
-- uniqueness constraint on the wrong column.

/* ------------------------------------------------- outcome instances */

ALTER TABLE nyst_outcome_instances
  ADD COLUMN IF NOT EXISTS request_key text CHECK (request_key IS NULL OR length(request_key) BETWEEN 1 AND 400);

-- Existing instances were keyed on the subject, so for them the subject WAS
-- the request. Backfilling with subject_key preserves their identity exactly.
UPDATE nyst_outcome_instances SET request_key = subject_key WHERE request_key IS NULL;

ALTER TABLE nyst_outcome_instances
  ALTER COLUMN request_key SET NOT NULL;

-- Dropped, not widened. Leaving it would keep the defect while looking fixed.
--
-- Found by its COLUMNS rather than its name. The name was auto-generated and
-- truncated by PostgreSQL to fit the 63-character identifier limit, which makes
-- the exact string a function of the server's truncation rather than anything
-- this file controls -- writing the guessed name here failed on the first run
-- for precisely that reason. Matching on (environment_id, outcome_contract_id,
-- subject_key) says what is actually meant.
DO $$
DECLARE
  target text;
BEGIN
  SELECT c.conname INTO target
  FROM pg_constraint c
  WHERE c.conrelid = 'nyst_outcome_instances'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM unnest(c.conkey) k JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = k
    ) = ARRAY['environment_id','outcome_contract_id','subject_key'];

  IF target IS NULL THEN
    RAISE NOTICE 'the subject-keyed unique constraint is already gone; nothing to drop';
  ELSE
    EXECUTE format('ALTER TABLE nyst_outcome_instances DROP CONSTRAINT %I', target);
  END IF;
END $$;

-- LIVE requests only. `completed_at` is set when an instance settles, times out
-- or is cancelled, so a finished outcome stops reserving its request key and
-- the same person can be the subject of a new one.
CREATE UNIQUE INDEX IF NOT EXISTS nyst_outcome_instances_live_request
  ON nyst_outcome_instances (environment_id, outcome_contract_id, request_key)
  WHERE completed_at IS NULL;

-- Two LIVE outcomes for one subject under one contract is still a hazard --
-- two offboardings racing on the same person -- so that stays refused, even
-- when the request keys differ.
CREATE UNIQUE INDEX IF NOT EXISTS nyst_outcome_instances_live_subject
  ON nyst_outcome_instances (environment_id, outcome_contract_id, subject_key)
  WHERE completed_at IS NULL;

-- The subject is now a lookup key rather than a uniqueness key: everything
-- Nyst has ever established about one person, newest first.
CREATE INDEX IF NOT EXISTS nyst_outcome_instances_subject_history
  ON nyst_outcome_instances (environment_id, subject_key, started_at DESC);

/* ------------------------------------------------- offboarding runs */

-- business_key is already the request key here, and already UNIQUE. The
-- subject_key constraint added nothing except the permanent lockout.
DO $$
DECLARE
  target text;
BEGIN
  SELECT c.conname INTO target
  FROM pg_constraint c
  WHERE c.conrelid = 'outcome_offboarding_runs'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text)
      FROM unnest(c.conkey) k JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = k
    ) = ARRAY['subject_key'];

  IF target IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outcome_offboarding_runs DROP CONSTRAINT %I', target);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS outcome_offboarding_runs_subject
  ON outcome_offboarding_runs (subject_key, created_at DESC);
