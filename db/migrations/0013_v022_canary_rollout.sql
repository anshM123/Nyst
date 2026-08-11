-- Nyst v0.2.2 — Phase 8: Shadow → Canary → Enforced.
--
-- CANARY is a DETERMINISTIC, explicitly scoped enforcement slice. It is never
-- probabilistic and never percentage-based: enforcing a random 5% of refunds
-- would mean the customer cannot say which refunds were protected, which is
-- the opposite of what Nyst sells.
--
-- The scope is exactly: Agent + EffectSpec + Environment.

ALTER TABLE nyst_environments DROP CONSTRAINT nyst_environments_mode_check;
ALTER TABLE nyst_environments ADD CONSTRAINT nyst_environments_mode_check
  CHECK (mode IN ('shadow','canary','enforced'));

ALTER TABLE nyst_environment_mode_audit DROP CONSTRAINT IF EXISTS nyst_environment_mode_audit_previous_mode_check;
ALTER TABLE nyst_environment_mode_audit DROP CONSTRAINT IF EXISTS nyst_environment_mode_audit_new_mode_check;
ALTER TABLE nyst_environment_mode_audit
  ADD CONSTRAINT nyst_environment_mode_audit_previous_mode_check CHECK (previous_mode IN ('shadow','canary','enforced')),
  ADD CONSTRAINT nyst_environment_mode_audit_new_mode_check CHECK (new_mode IN ('shadow','canary','enforced'));

ALTER TABLE nyst_action_policy_bindings DROP CONSTRAINT IF EXISTS nyst_action_policy_bindings_environment_mode_check;
ALTER TABLE nyst_action_policy_bindings ADD CONSTRAINT nyst_action_policy_bindings_environment_mode_check
  CHECK (environment_mode IN ('shadow','canary','enforced'));

-- One row = one explicitly enforced slice while the environment is in Canary.
CREATE TABLE nyst_canary_rules (
  canary_rule_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  effect_name text NOT NULL CHECK (length(effect_name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES nyst_users(user_id),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  UNIQUE (environment_id, agent_id, effect_name),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  -- The Agent must belong to the same tenant scope, so a rule can never widen
  -- enforcement across a tenant boundary.
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);
CREATE INDEX nyst_canary_rules_lookup ON nyst_canary_rules(environment_id, agent_id, effect_name) WHERE enabled;

-- Every scope change is audited; the audit is append-only.
CREATE TABLE nyst_canary_rule_audit (
  audit_id uuid PRIMARY KEY,
  canary_rule_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  effect_name text NOT NULL,
  change text NOT NULL CHECK (change IN ('created','enabled','disabled')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  changed_by uuid REFERENCES nyst_users(user_id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER nyst_canary_rule_audit_immutable
  BEFORE UPDATE OR DELETE ON nyst_canary_rule_audit
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();

-- The mode an action was created under is already stored on
-- nyst_action_policy_bindings and that table is write-once, so a historical
-- action is never reinterpreted when the environment mode later changes.
