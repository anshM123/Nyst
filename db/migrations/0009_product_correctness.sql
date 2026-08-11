-- Nyst v0.2.1 product correctness and end-to-end control hardening. Not Gate 9.
BEGIN;

ALTER TABLE nyst_action_policy_bindings
  ADD COLUMN reconcile_deadline_at timestamptz;
UPDATE nyst_action_policy_bindings b SET reconcile_deadline_at=b.bound_at+(p.reconcile_timeout_seconds::text||' seconds')::interval
FROM nyst_policy_versions p WHERE p.policy_version_id=b.policy_version_id;
ALTER TABLE nyst_action_policy_bindings ALTER COLUMN reconcile_deadline_at SET NOT NULL;

CREATE TABLE nyst_resolution_transitions (
  transition_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  resolution_id uuid NOT NULL REFERENCES outcome_resolutions(resolution_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('action_commit','scheduler','manual_reconcile','recovery_worker','human_review','compensation','backfill')),
  event_type text NOT NULL CHECK (event_type IN ('action.pending','effect.resolved','continuation.authorized','human_review.required','recovery.completed','compensation.completed','webhook.test')),
  effect_state text NOT NULL CHECK (effect_state IN ('verified','not_applied','pending','compensated','satisfied_unattributed','unprovable')),
  primary_directive text NOT NULL CHECK (primary_directive IN ('continue','retry','do_not_retry','hold','compensate','escalate')),
  retry_disposition text NOT NULL CHECK (retry_disposition IN ('allowed','forbidden','unknown')),
  continuation_disposition text NOT NULL CHECK (continuation_disposition IN ('allowed','blocked','conditional')),
  recovery_disposition text NOT NULL CHECK (recovery_disposition IN ('none','compensate','escalate')),
  resolution_sequence integer NOT NULL CHECK (resolution_sequence >= 1),
  evidence_sequence integer NOT NULL CHECK (evidence_sequence >= 0),
  receipt_ref text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id,resolution_id),
  FOREIGN KEY (environment_id,project_id,organization_id) REFERENCES nyst_environments(environment_id,project_id,organization_id)
);

CREATE TABLE nyst_control_events (
  control_event_id uuid PRIMARY KEY,
  transition_id uuid NOT NULL REFERENCES nyst_resolution_transitions(transition_id),
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('retry_blocked','continuation_blocked','automatic_recovery_completed','human_escalation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transition_id,event_kind),
  FOREIGN KEY (environment_id,project_id,organization_id) REFERENCES nyst_environments(environment_id,project_id,organization_id)
);

ALTER TABLE nyst_webhook_events DROP CONSTRAINT nyst_webhook_events_event_type_check;
ALTER TABLE nyst_webhook_events ADD CONSTRAINT nyst_webhook_events_event_type_check CHECK
  (event_type IN ('action.pending','effect.resolved','continuation.authorized','human_review.required','recovery.completed','compensation.completed','webhook.test'));
ALTER TABLE nyst_webhook_events ADD COLUMN event_schema_version integer NOT NULL DEFAULT 1 CHECK (event_schema_version=1);

CREATE TABLE nyst_reobservation_jobs (
  reobservation_job_id uuid PRIMARY KEY,
  human_review_id uuid NOT NULL REFERENCES nyst_human_reviews(human_review_id),
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','executing','completed','failed')),
  claim_token uuid,
  claimed_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (human_review_id),
  CHECK ((claim_token IS NULL)=(claimed_until IS NULL)),
  FOREIGN KEY (environment_id,project_id,organization_id) REFERENCES nyst_environments(environment_id,project_id,organization_id)
);

ALTER TABLE nyst_recovery_executions
  ADD COLUMN resolution_sequence integer,
  ADD COLUMN evidence_sequence integer,
  ADD COLUMN downstream_operation_key text,
  ADD COLUMN attempted_at timestamptz,
  ADD COLUMN result jsonb;
CREATE UNIQUE INDEX nyst_recovery_operation_key_uq ON nyst_recovery_executions(downstream_operation_key) WHERE downstream_operation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION nyst_forbid_v021_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only/immutable',TG_TABLE_NAME; END; $$;
CREATE TRIGGER nyst_policy_versions_immutable BEFORE UPDATE OR DELETE ON nyst_policy_versions FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();
CREATE TRIGGER nyst_environment_mode_audit_immutable BEFORE UPDATE OR DELETE ON nyst_environment_mode_audit FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();
CREATE TRIGGER nyst_resolution_transitions_immutable BEFORE UPDATE OR DELETE ON nyst_resolution_transitions FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();
CREATE TRIGGER nyst_control_events_immutable BEFORE UPDATE OR DELETE ON nyst_control_events FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();
CREATE TRIGGER nyst_webhook_attempts_immutable BEFORE UPDATE OR DELETE ON nyst_webhook_attempts FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();

COMMIT;
