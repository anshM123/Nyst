-- Nyst v0.2.0 design-partner product controls. This is not Gate 9.
-- Product policy may reduce runtime authority but never expand it.
BEGIN;

ALTER TABLE nyst_environments
  ADD COLUMN mode text NOT NULL DEFAULT 'enforced' CHECK (mode IN ('shadow','enforced')),
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN onboarding_stage integer NOT NULL DEFAULT 0 CHECK (onboarding_stage BETWEEN 0 AND 10);

CREATE TABLE nyst_environment_mode_audit (
  audit_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  previous_mode text NOT NULL CHECK (previous_mode IN ('shadow','enforced')),
  new_mode text NOT NULL CHECK (new_mode IN ('shadow','enforced')),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  FOREIGN KEY (changed_by,organization_id) REFERENCES nyst_users(user_id,organization_id)
);

CREATE TABLE nyst_policy_versions (
  policy_version_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  effect_name text,
  version integer NOT NULL CHECK (version >= 1),
  execution_mode text NOT NULL CHECK (execution_mode IN ('automatic','approval_required')),
  retry_mode text NOT NULL DEFAULT 'never' CHECK (retry_mode = 'never'),
  auto_continuation boolean NOT NULL DEFAULT false,
  auto_compensation boolean NOT NULL DEFAULT false,
  reconcile_timeout_seconds integer NOT NULL CHECK (reconcile_timeout_seconds BETWEEN 30 AND 86400),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  FOREIGN KEY (created_by,organization_id) REFERENCES nyst_users(user_id,organization_id),
  UNIQUE (environment_id,effect_name,version)
);
CREATE UNIQUE INDEX nyst_policy_one_default_version
  ON nyst_policy_versions(environment_id,version) WHERE effect_name IS NULL;

CREATE TABLE nyst_action_policy_bindings (
  action_id uuid PRIMARY KEY REFERENCES outcome_actions(action_id),
  policy_version_id uuid NOT NULL REFERENCES nyst_policy_versions(policy_version_id),
  environment_mode text NOT NULL CHECK (environment_mode IN ('shadow','enforced')),
  bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER nyst_action_policy_bindings_immutable
BEFORE UPDATE OR DELETE ON nyst_action_policy_bindings
FOR EACH ROW EXECUTE FUNCTION nyst_forbid_scope_change();

CREATE OR REPLACE FUNCTION nyst_require_product_control_before_prepare()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE namespace text;
BEGIN
  namespace := split_part(NEW.business_key, ':', 1);
  IF NEW.internal_state='prepared' AND OLD.internal_state='intent_recorded'
     AND namespace ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM nyst_environments WHERE environment_id=namespace::uuid)
     AND NOT EXISTS (SELECT 1 FROM nyst_action_policy_bindings WHERE action_id=NEW.action_id) THEN
    RAISE EXCEPTION 'product action requires immutable mode/policy binding before preparation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nyst_action_control_before_prepare
BEFORE UPDATE ON outcome_actions FOR EACH ROW
EXECUTE FUNCTION nyst_require_product_control_before_prepare();

CREATE TABLE nyst_shadow_evaluations (
  shadow_evaluation_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  effect_name text NOT NULL,
  business_key text NOT NULL CHECK (length(business_key) BETWEEN 1 AND 463),
  observation jsonb NOT NULL,
  observed_ambiguous boolean NOT NULL,
  attempted_retry boolean NOT NULL,
  attempted_continuation boolean NOT NULL,
  retry_would_have_been_blocked boolean NOT NULL,
  continuation_would_have_been_blocked boolean NOT NULL,
  assessment jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  UNIQUE (environment_id,effect_name,business_key)
);

CREATE TABLE nyst_webhook_endpoints (
  webhook_endpoint_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  target_url text NOT NULL CHECK (length(target_url) BETWEEN 12 AND 2048),
  signing_secret_ref text NOT NULL CHECK (
    signing_secret_ref ~ '^env:[A-Z][A-Z0-9_]{2,100}$'
    AND signing_secret_ref !~ '(Bearer|secret|token)[=:]'
  ),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  FOREIGN KEY (created_by,organization_id) REFERENCES nyst_users(user_id,organization_id),
  UNIQUE (environment_id)
);

CREATE TABLE nyst_webhook_events (
  webhook_event_id uuid PRIMARY KEY,
  webhook_endpoint_id uuid NOT NULL REFERENCES nyst_webhook_endpoints(webhook_endpoint_id),
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  resolution_id uuid NOT NULL REFERENCES outcome_resolutions(resolution_id),
  resolution_sequence integer NOT NULL CHECK (resolution_sequence >= 1),
  evidence_sequence integer NOT NULL CHECK (evidence_sequence >= 0),
  event_type text NOT NULL CHECK (event_type IN ('effect.resolved','continuation.authorized','human_review.required','compensation.completed')),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  terminal_at timestamptz,
  claim_token uuid,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_endpoint_id,action_id,resolution_id,event_type),
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE INDEX nyst_webhook_events_due_idx ON nyst_webhook_events(next_attempt_at)
  WHERE delivered_at IS NULL AND terminal_at IS NULL;

CREATE TABLE nyst_webhook_attempts (
  webhook_attempt_id uuid PRIMARY KEY,
  webhook_event_id uuid NOT NULL REFERENCES nyst_webhook_events(webhook_event_id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  response_status integer,
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_event_id,attempt_number)
);

CREATE TABLE nyst_recovery_executions (
  recovery_execution_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  resolution_id uuid NOT NULL REFERENCES outcome_resolutions(resolution_id),
  policy_version_id uuid NOT NULL REFERENCES nyst_policy_versions(policy_version_id),
  operation text NOT NULL CHECK (operation IN ('authorized_continuation','supported_compensation')),
  status text NOT NULL CHECK (status IN ('authorized','executing','completed','failed')),
  claim_token uuid,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (action_id,resolution_id,operation),
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);

CREATE TABLE nyst_human_reviews (
  human_review_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('open','acknowledged','reobservation_requested','closed')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  opened_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  FOREIGN KEY (reviewed_by,organization_id) REFERENCES nyst_users(user_id,organization_id),
  UNIQUE (action_id)
);

CREATE TABLE nyst_failure_lab_runs (
  failure_lab_run_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  scenario text NOT NULL CHECK (scenario IN ('response_lost','timeout_before_send','delayed_observation','reconcile_rate_limit','duplicate_caller','process_crash','offboarding_demo')),
  effect_name text NOT NULL,
  seed integer NOT NULL,
  result jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id,project_id,organization_id)
    REFERENCES nyst_environments(environment_id,project_id,organization_id),
  FOREIGN KEY (created_by,organization_id) REFERENCES nyst_users(user_id,organization_id)
);

CREATE TABLE nyst_audit_events (
  audit_event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  project_id uuid,
  environment_id uuid,
  actor_user_id uuid,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 3 AND 100),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 2 AND 60),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_user_id,organization_id) REFERENCES nyst_users(user_id,organization_id)
);

COMMIT;
