-- Nyst v0.3.1 — issue 7. ONE CURRENT FACT, AND IT IS THE LATEST OBSERVED ONE.
--
-- 0020 gave nyst_world_facts an index over the current facts:
--
--   CREATE INDEX nyst_world_facts_lookup
--     ON nyst_world_facts (environment_id, subject_ref, property, observed_at DESC)
--     WHERE superseded_at IS NULL;
--
-- An index, not a UNIQUE index. So "there is one current fact per subject and
-- property" was a convention held up entirely by recordFact's read-then-write,
-- and that read-then-write had no lock between its steps. Two observations
-- arriving together both read the same incumbent, both inserted, and both
-- superseded the same row -- leaving two rows with superseded_at IS NULL. The
-- invariant engine then received two contradictory statements about one
-- property, with no rule for which one wins.
--
-- This makes it structural. A second current fact is now rejected by the
-- database, whoever writes it and by whatever path.
--
-- Note the shape: (environment_id, subject_ref, provider, property). PROVIDER
-- is part of the key deliberately. GitHub and Okta may both hold a current fact
-- about the same property of the same subject -- they are separate authorities,
-- and collapsing them would discard exactly the disagreement the Outcome layer
-- exists to notice.

-- REPAIR FIRST.
--
-- Any database that ran the previous code may already hold duplicate current
-- facts -- this migration failed to apply on the development database for
-- exactly that reason, which is the defect leaving its own fingerprint. A
-- migration that only works on databases that never hit the bug is not a
-- migration, so the existing duplicates are resolved before the constraint
-- goes on.
--
-- The resolution is the same rule the trigger below enforces: the fact observed
-- LAST stays current. Ties break on recorded_at and then fact_id, so the
-- outcome is deterministic rather than dependent on scan order. Nothing is
-- deleted -- the losers are superseded, and stay readable as history.
WITH ranked AS (
  SELECT fact_id,
         row_number() OVER (
           PARTITION BY environment_id, subject_ref, provider, property
           ORDER BY observed_at DESC, recorded_at DESC, fact_id DESC
         ) AS rank
  FROM nyst_world_facts
  WHERE superseded_at IS NULL
)
UPDATE nyst_world_facts f
   SET superseded_at = now()
  FROM ranked
 WHERE f.fact_id = ranked.fact_id
   AND ranked.rank > 1;

CREATE UNIQUE INDEX nyst_world_facts_single_current
  ON nyst_world_facts (environment_id, subject_ref, provider, property)
  WHERE superseded_at IS NULL;

-- The old non-unique index is now redundant for lookups by that key, but it
-- carries observed_at DESC, which the history queries order by. Kept.

-- SUPERSESSION MUST FOLLOW OBSERVATION TIME, NOT ARRIVAL TIME.
--
-- recordFact chose the incumbent with ORDER BY observed_at DESC but never
-- compared the INCOMING fact's observed_at against it. A late-arriving older
-- observation therefore superseded a newer one and became current: Nyst's
-- picture of the world moved backwards in time.
--
-- In this product that is not an ordering nicety. Nyst observes at 10:05 that
-- Alice still has WRITE; a delayed 10:00 observation saying "none" lands at
-- 10:06, supersedes it, and becomes current. The outcome flips to SATISFIED and
-- the Agent is cleared to continue -- on evidence that was already stale when it
-- arrived. Nyst would be reporting that access was removed while it was live.
--
-- This trigger enforces the ordering at the row level. It cannot be bypassed by
-- a future writer that reimplements the lookup, and it states the rule where
-- the data is rather than where one function happens to be.
CREATE OR REPLACE FUNCTION nyst_world_facts_supersession_order() RETURNS trigger AS $$
DECLARE
  incumbent_observed_at timestamptz;
BEGIN
  -- Only rows arriving as CURRENT make a claim about present truth. A row
  -- inserted already-superseded is history being backfilled, which is allowed
  -- at any observation time.
  IF NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT observed_at INTO incumbent_observed_at
  FROM nyst_world_facts
  WHERE environment_id = NEW.environment_id
    AND subject_ref = NEW.subject_ref
    AND provider = NEW.provider
    AND property = NEW.property
    AND superseded_at IS NULL
    AND fact_id <> NEW.fact_id;

  IF incumbent_observed_at IS NOT NULL AND NEW.observed_at <= incumbent_observed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a fact observed at ' || NEW.observed_at || ' cannot supersede one observed at ' || incumbent_observed_at,
      HINT = 'Later evidence supersedes earlier evidence, where later means observed later, not arrived later. '
             'Record the stale observation with superseded_at set, so it is kept as history rather than as truth.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_world_facts_supersession_order
  BEFORE INSERT ON nyst_world_facts
  FOR EACH ROW EXECUTE FUNCTION nyst_world_facts_supersession_order();

-- A tie is not later. Two observations at the same instant leave the incumbent
-- standing, which makes the rule total: strictly-later supersedes, everything
-- else is history. Without that, equal timestamps would thrash.

-- Reading the history of one subject and property in observation order is the
-- other query this table serves, and it now happens on every stale arrival.
CREATE INDEX IF NOT EXISTS nyst_world_facts_history
  ON nyst_world_facts (environment_id, subject_ref, provider, property, observed_at DESC);
