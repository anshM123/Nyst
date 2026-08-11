-- Nyst v0.2.2 — Phase 1 launch-blocking correctness.
--
-- 1C durable automatic-reconciliation suppression
-- 1D/1E/1F recovery dispatch boundary, reclaim discipline, terminal states
-- 1G re-observation reclaim discipline
-- 1H Shadow exact EffectSpec version binding
-- 1J truthful readiness / read-only provider preflight records
-- 1K durable intervention events (one logical intervention, once)

-- =====================================================================
-- 1C — durable suppression of the automatic reconciliation loop.
--
-- Deleting nyst_reconciliation_jobs is not durable: scheduler.sync()
-- re-derives jobs from outcome_runtime.next_check_at, so escalation was
-- undone by the next sync or by any process restart. Suppression is now a
-- product-level fact that outlives both.
--
-- Historical outcome_runtime.next_check_at is deliberately preserved as
-- runtime evidence. It simply stops being an authority to schedule work.
-- =====================================================================
CREATE TABLE nyst_reconciliation_suppressions (
  action_id uuid PRIMARY KEY REFERENCES outcome_actions(action_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  source text NOT NULL CHECK (source IN ('policy_deadline','human_review','freeze','operator')),
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_reconciliation_suppressions_env ON nyst_reconciliation_suppressions(environment_id);

-- A suppression is a durable safety fact. It may be lifted only by deleting
-- the row through an explicit, audited product operation, never by UPDATE.
CREATE OR REPLACE FUNCTION nyst_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'nyst: % rows are immutable', TG_TABLE_NAME; END $$;

CREATE TRIGGER nyst_reconciliation_suppressions_immutable
  BEFORE UPDATE ON nyst_reconciliation_suppressions
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_update();

-- =====================================================================
-- 1D/1E/1F — recovery dispatch boundary.
--
-- Recovery MAY cause an external consequence, so an expired lease must not
-- imply "safe to run again". The durable dispatch_state is what decides.
-- =====================================================================
ALTER TABLE nyst_recovery_executions
  ADD COLUMN dispatch_state text NOT NULL DEFAULT 'definitely_not_sent',
  ADD COLUMN attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN recovery_operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN needs_review_reason text,
  ADD COLUMN observed_at timestamptz;

ALTER TABLE nyst_recovery_executions DROP CONSTRAINT nyst_recovery_executions_status_check;

UPDATE nyst_recovery_executions SET dispatch_state='completed' WHERE status='completed';
-- v0.2.1 recorded a post-dispatch executor failure as 'failed'. That is exactly
-- the may-have-been-sent case, and it is not a terminal state.
UPDATE nyst_recovery_executions SET
    dispatch_state='may_have_been_sent',
    status='needs_review',
    needs_review_reason='Migrated from v0.2.1 terminal failed state; the external recovery consequence is unproven.'
  WHERE status='failed';

ALTER TABLE nyst_recovery_executions
  ADD CONSTRAINT nyst_recovery_executions_status_check
    CHECK (status IN ('authorized','executing','observing','completed','needs_review','cancelled')),
  ADD CONSTRAINT nyst_recovery_dispatch_state_check
    CHECK (dispatch_state IN ('definitely_not_sent','attempted','may_have_been_sent','ambiguous','completed')),
  ADD CONSTRAINT nyst_recovery_operation_id_uq UNIQUE (recovery_operation_id),
  ADD CONSTRAINT nyst_recovery_attempt_check CHECK (attempt >= 0 AND attempt <= 100);

-- A completed recovery must have crossed the dispatch boundary; a cancelled one
-- must never have. This is the invariant that makes reclaim decisions sound.
ALTER TABLE nyst_recovery_executions ADD CONSTRAINT nyst_recovery_terminal_dispatch_check
  CHECK ((status <> 'completed' OR dispatch_state = 'completed')
     AND (status <> 'cancelled' OR dispatch_state = 'definitely_not_sent'));

-- Append-only evidence of where each attempt stopped relative to the send.
CREATE TABLE nyst_recovery_dispatch_attempts (
  dispatch_attempt_id uuid PRIMARY KEY,
  recovery_execution_id uuid NOT NULL REFERENCES nyst_recovery_executions(recovery_execution_id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  claim_token uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('claimed','before_send','after_send','observed','failed_before_send','failed_after_send','cancelled')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recovery_execution_id, attempt, phase)
);
CREATE TRIGGER nyst_recovery_dispatch_attempts_immutable
  BEFORE UPDATE OR DELETE ON nyst_recovery_dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();

-- =====================================================================
-- 1G — re-observation reclaim. Re-observation is READ-ONLY, so an expired
-- claim is always safe to reclaim; only the attempt count is bounded.
-- =====================================================================
ALTER TABLE nyst_reobservation_jobs
  ADD COLUMN attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error_code text;
ALTER TABLE nyst_reobservation_jobs ADD CONSTRAINT nyst_reobservation_attempt_check
  CHECK (attempt >= 0 AND attempt <= 100);
ALTER TABLE nyst_reobservation_jobs DROP CONSTRAINT nyst_reobservation_jobs_status_check;
UPDATE nyst_reobservation_jobs SET status='needs_review' WHERE status='failed';
ALTER TABLE nyst_reobservation_jobs ADD CONSTRAINT nyst_reobservation_jobs_status_check
  CHECK (status IN ('requested','executing','completed','needs_review','cancelled'));

-- =====================================================================
-- 1H — Shadow records bind to the exact EffectSpec version, the Agent, and
-- the mode that were in force. Historical records are never reinterpreted.
-- =====================================================================
ALTER TABLE nyst_shadow_evaluations ADD COLUMN spec_version text;
UPDATE nyst_shadow_evaluations SET spec_version = coalesce(
  (SELECT f.spec_version FROM nyst_environment_effect_specs f
    WHERE f.environment_id = nyst_shadow_evaluations.environment_id
      AND f.effect_name = nyst_shadow_evaluations.effect_name),
  'legacy/unversioned');
ALTER TABLE nyst_shadow_evaluations
  ALTER COLUMN spec_version SET NOT NULL,
  ADD CONSTRAINT nyst_shadow_spec_version_check CHECK (length(spec_version) BETWEEN 1 AND 200),
  ADD COLUMN observation_schema_version integer NOT NULL DEFAULT 1;

-- =====================================================================
-- 1J — read-only provider preflight results. Never stores a credential,
-- only the categorical outcome and the observable provider identity.
-- =====================================================================
CREATE TABLE nyst_integration_preflights (
  preflight_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','okta','stripe')),
  status text NOT NULL CHECK (status IN (
    'verified_ready','credential_unavailable','authentication_failed','insufficient_permission',
    'resource_missing','unsupported_topology','provider_unavailable')),
  account_identity text CHECK (account_identity IS NULL OR length(account_identity) <= 200),
  scope_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_detail text CHECK (failure_detail IS NULL OR length(failure_detail) <= 500),
  provider_mutation_performed boolean NOT NULL DEFAULT false
    CONSTRAINT nyst_preflight_is_read_only CHECK (provider_mutation_performed = false),
  performed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_integration_preflights_recent
  ON nyst_integration_preflights(environment_id, provider, performed_at DESC);
CREATE TRIGGER nyst_integration_preflights_immutable
  BEFORE UPDATE OR DELETE ON nyst_integration_preflights
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();

-- =====================================================================
-- 1K — durable intervention events.
--
-- intervention_key is the logical identity of ONE intervention. Scheduler
-- runs, repeated observations, webhook attempts, and page refreshes all
-- collapse onto the same key, so a single logical intervention can never be
-- counted twice.
-- =====================================================================
CREATE TABLE nyst_intervention_events (
  intervention_id uuid PRIMARY KEY,
  intervention_key text NOT NULL UNIQUE CHECK (length(intervention_key) BETWEEN 1 AND 400),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  action_id uuid REFERENCES outcome_actions(action_id),
  shadow_evaluation_id uuid REFERENCES nyst_shadow_evaluations(shadow_evaluation_id),
  effect_name text NOT NULL CHECK (length(effect_name) BETWEEN 1 AND 200),
  mode text NOT NULL CHECK (mode IN ('shadow','canary','enforced')),
  kind text NOT NULL CHECK (kind IN (
    'retry_blocked','continuation_blocked','auto_resolved','human_review_opened',
    'shadow_retry_would_have_been_blocked','shadow_continuation_would_have_been_blocked',
    'blast_radius_hold','freeze_blocked','recovery_needs_review')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 400),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- An intervention is attached either to a durable action or to a durable
  -- Shadow record. It is never free-floating narrative.
  CONSTRAINT nyst_intervention_subject CHECK (action_id IS NOT NULL OR shadow_evaluation_id IS NOT NULL),
  -- Shadow interventions are counterfactual by construction and can never be
  -- recorded as an Enforced prevention.
  CONSTRAINT nyst_intervention_shadow_language CHECK (
    (mode = 'shadow') = (kind IN ('shadow_retry_would_have_been_blocked','shadow_continuation_would_have_been_blocked'))),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_intervention_events_recent
  ON nyst_intervention_events(environment_id, occurred_at DESC);
CREATE INDEX nyst_intervention_events_kind
  ON nyst_intervention_events(environment_id, kind, action_id);
CREATE TRIGGER nyst_intervention_events_immutable
  BEFORE UPDATE OR DELETE ON nyst_intervention_events
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();
