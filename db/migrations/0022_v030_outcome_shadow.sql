-- Nyst v0.3.0 — Phase 27. OUTCOME SHADOW.
--
-- The customer changes nothing. Their Agent keeps running exactly as it does
-- today, keeps deciding for itself when a workflow is finished, and keeps
-- being wrong occasionally. Nyst watches, evaluates the OUTCOME independently,
-- and reports the gap.
--
-- The finding this exists to produce:
--
--     Your Agent considered this offboarding complete at 14:02:11.
--     Inherited GitHub production access remained until 14:16:34.
--     14 minutes 23 seconds.
--
-- Nyst prevented nothing here and must never say it did. Shadow speaks in the
-- counterfactual: DETECTED, OBSERVED, WOULD HAVE BLOCKED.

-- When an Agent tells Nyst it considers a workflow finished.
--
-- This is the Agent's CLAIM, recorded as a claim. It is never evidence about
-- the world, and it never moves a verdict — the whole value of the feature is
-- the distance between this row and what Nyst independently observed.
CREATE TABLE nyst_agent_completion_signals (
  completion_signal_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outcome_instance_id uuid NOT NULL REFERENCES nyst_outcome_instances(outcome_instance_id) ON DELETE CASCADE,
  agent_id uuid,
  -- What the Agent said, verbatim, bounded.
  declared_status text NOT NULL CHECK (declared_status IN ('complete','failed','abandoned')),
  declared_at timestamptz NOT NULL,
  -- Nyst's own verdict AT THE MOMENT the claim arrived. Frozen here so the
  -- finding does not have to be reconstructed later from a moving instance.
  verdict_at_signal text NOT NULL CHECK (verdict_at_signal IN ('satisfied','unsatisfied','indeterminate')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (declared_at <= received_at + interval '1 hour'),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_agent_completion_signals_instance
  ON nyst_agent_completion_signals (outcome_instance_id, declared_at);

-- A claim is a historical fact. It is never edited.
CREATE OR REPLACE FUNCTION nyst_agent_completion_signals_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'nyst_agent_completion_signals is append-only: an Agent''s claim is a record of what it said, when';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_agent_completion_signals_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_agent_completion_signals
  FOR EACH ROW EXECUTE FUNCTION nyst_agent_completion_signals_immutable();

-- One durable Shadow finding: a gap Nyst observed but did not close.
--
-- `exposure_seconds` is only written once the outcome ACTUALLY became
-- satisfied, or is left null while the exposure is still open. Nyst does not
-- estimate how long a window lasted.
CREATE TABLE nyst_outcome_shadow_findings (
  shadow_finding_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outcome_instance_id uuid NOT NULL REFERENCES nyst_outcome_instances(outcome_instance_id) ON DELETE CASCADE,
  completion_signal_id uuid REFERENCES nyst_agent_completion_signals(completion_signal_id),
  kind text NOT NULL CHECK (kind IN (
    'declared_complete_too_early',    -- the Agent said done; Nyst says not yet
    'unsafe_continuation_opportunity',-- Enforced would have held this
    'temporarily_indeterminate',      -- Nyst could not see, for a while
    'established_later',              -- it became true on its own, after
    'human_review_opportunity'        -- Enforced would have asked a person
  )),
  -- The invariant that was false or unknown when the Agent declared victory.
  invariant_id text,
  -- The sentence a salesperson reads out loud. Counterfactual voice only.
  finding text NOT NULL CHECK (length(btrim(finding)) BETWEEN 20 AND 2000),
  observed_from timestamptz NOT NULL,
  observed_until timestamptz,
  exposure_seconds integer CHECK (exposure_seconds IS NULL OR exposure_seconds >= 0),
  CHECK ((observed_until IS NULL) = (exposure_seconds IS NULL)),
  CHECK (observed_until IS NULL OR observed_until >= observed_from),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_outcome_shadow_findings_scope
  ON nyst_outcome_shadow_findings (environment_id, kind, created_at DESC);

-- One open finding of a given kind per outcome. Closing it writes the
-- exposure; a new window opens a new row.
CREATE UNIQUE INDEX nyst_outcome_shadow_findings_open
  ON nyst_outcome_shadow_findings (outcome_instance_id, kind)
  WHERE observed_until IS NULL;
