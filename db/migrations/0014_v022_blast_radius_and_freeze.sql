-- Nyst v0.2.2 — Phase 10 (Blast Radius) and Phase 11 (Emergency Freeze).

-- =====================================================================
-- PHASE 10 — BLAST RADIUS GUARD
--
-- Nyst already answers "did this action happen?". Blast Radius answers
-- "is this Agent executing too much consequence?".
--
-- Deliberately a constrained consequence budget, NOT a general policy
-- language. Three limits only, over three scopes.
--
-- Monetary limits are accepted ONLY for EffectSpecs whose semantics carry an
-- authoritative amount and currency. Money is never parsed out of free text.
-- =====================================================================
CREATE TABLE nyst_blast_radius_budgets (
  budget_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  -- NULL agent_id = every Agent in the environment; NULL effect_name = every effect.
  agent_id uuid,
  effect_name text CHECK (effect_name IS NULL OR length(effect_name) BETWEEN 1 AND 200),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 86400),
  max_actions_per_window integer CHECK (max_actions_per_window IS NULL OR max_actions_per_window >= 1),
  -- Minor units (cents). Integers only; floating-point money is not money.
  max_amount_minor_per_action bigint CHECK (max_amount_minor_per_action IS NULL OR max_amount_minor_per_action >= 1),
  max_amount_minor_per_window bigint CHECK (max_amount_minor_per_window IS NULL OR max_amount_minor_per_window >= 1),
  currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES nyst_users(user_id),
  -- A budget that limits nothing is a configuration mistake, not a no-op.
  CONSTRAINT nyst_blast_radius_has_a_limit CHECK (
    max_actions_per_window IS NOT NULL OR max_amount_minor_per_action IS NOT NULL OR max_amount_minor_per_window IS NOT NULL),
  -- Any monetary limit requires the currency it is denominated in.
  CONSTRAINT nyst_blast_radius_money_needs_currency CHECK (
    (max_amount_minor_per_action IS NULL AND max_amount_minor_per_window IS NULL) OR currency IS NOT NULL),
  UNIQUE (environment_id, agent_id, effect_name),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);

-- Consumption accounting lives in nyst_consequence_admissions (below), not in
-- a separate table. That is deliberate: the count a budget check reads and the
-- row that consumes the budget MUST be written by the same statement under the
-- same lock, otherwise two concurrent admissions each read a stale total and
-- both are admitted.

-- Every admit/hold decision is persisted, including the numbers it was based on.
CREATE TABLE nyst_blast_radius_decisions (
  decision_id uuid PRIMARY KEY,
  budget_id uuid REFERENCES nyst_blast_radius_budgets(budget_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  agent_id uuid,
  effect_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('admitted','held')),
  limit_kind text CHECK (limit_kind IN ('action_count','amount_per_action','amount_per_window')),
  observed_value bigint,
  limit_value bigint,
  window_seconds integer,
  business_key text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_blast_radius_decisions_recent ON nyst_blast_radius_decisions(environment_id, decided_at DESC);
CREATE TRIGGER nyst_blast_radius_decisions_immutable
  BEFORE UPDATE OR DELETE ON nyst_blast_radius_decisions
  FOR EACH ROW EXECUTE FUNCTION nyst_forbid_v021_mutation();

-- =====================================================================
-- PHASE 11 — EMERGENCY FREEZE
--
-- While a freeze is durably active, ZERO new consequential provider mutations
-- may BEGIN inside its scope. Read-only work — observation, reconciliation,
-- evidence reads, receipt verification, Human Review inspection — continues.
-- Freeze does not kill Nyst; it stops new consequence.
--
-- LINEARIZATION BOUNDARY: a freeze becomes active at the instant its row is
-- committed. An action is admitted only if no committed freeze covering its
-- scope exists at the moment the admission row is written, and both happen in
-- the same statement. There is therefore no window in which an action can be
-- admitted after the freeze is visible.
-- =====================================================================
CREATE TABLE nyst_freezes (
  freeze_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  -- NULL = the whole environment.
  scope_agent_id uuid,
  scope_effect_name text CHECK (scope_effect_name IS NULL OR length(scope_effect_name) BETWEEN 1 AND 200),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  activated_by uuid NOT NULL REFERENCES nyst_users(user_id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES nyst_users(user_id),
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR length(release_reason) <= 500),
  CONSTRAINT nyst_freeze_release_is_complete
    CHECK ((released_at IS NULL) = (released_by IS NULL)),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  FOREIGN KEY (scope_agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);

-- At most one ACTIVE freeze per exact scope, so freeze/unfreeze cannot ABA into
-- two overlapping authorities for the same scope.
CREATE UNIQUE INDEX nyst_freezes_one_active_environment ON nyst_freezes(environment_id)
  WHERE released_at IS NULL AND scope_agent_id IS NULL AND scope_effect_name IS NULL;
CREATE UNIQUE INDEX nyst_freezes_one_active_agent ON nyst_freezes(environment_id, scope_agent_id)
  WHERE released_at IS NULL AND scope_agent_id IS NOT NULL AND scope_effect_name IS NULL;
CREATE UNIQUE INDEX nyst_freezes_one_active_effect ON nyst_freezes(environment_id, scope_effect_name)
  WHERE released_at IS NULL AND scope_agent_id IS NULL AND scope_effect_name IS NOT NULL;
CREATE UNIQUE INDEX nyst_freezes_one_active_pair ON nyst_freezes(environment_id, scope_agent_id, scope_effect_name)
  WHERE released_at IS NULL AND scope_agent_id IS NOT NULL AND scope_effect_name IS NOT NULL;
CREATE INDEX nyst_freezes_active ON nyst_freezes(environment_id) WHERE released_at IS NULL;

-- A freeze is history. Only the release fields may ever be written, once.
CREATE OR REPLACE FUNCTION nyst_guard_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'nyst: freeze history is immutable'; END IF;
  IF NEW.freeze_id <> OLD.freeze_id
     OR NEW.environment_id <> OLD.environment_id
     OR NEW.scope_agent_id IS DISTINCT FROM OLD.scope_agent_id
     OR NEW.scope_effect_name IS DISTINCT FROM OLD.scope_effect_name
     OR NEW.activated_by <> OLD.activated_by
     OR NEW.activated_at <> OLD.activated_at
     OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'nyst: freeze identity is immutable';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'nyst: a released freeze is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nyst_freezes_guard BEFORE UPDATE OR DELETE ON nyst_freezes
  FOR EACH ROW EXECUTE FUNCTION nyst_guard_freeze();

-- =====================================================================
-- Admission ledger — the single linearization point for "may this
-- consequence BEGIN?". Freeze and Blast Radius are both evaluated here, in
-- one statement, so neither can be raced.
-- =====================================================================
CREATE TABLE nyst_consequence_admissions (
  admission_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  agent_id uuid,
  effect_name text NOT NULL CHECK (length(effect_name) BETWEEN 1 AND 200),
  business_key text NOT NULL CHECK (length(business_key) BETWEEN 1 AND 500),
  -- Back-filled once the durable action exists, so a budget decision can be
  -- traced to the action it governed.
  action_id uuid REFERENCES outcome_actions(action_id),
  -- Authoritative monetary value of this consequence, from structured
  -- EffectSpec semantics. Integer minor units; never parsed from text.
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  admitted boolean NOT NULL,
  blocked_by text CHECK (blocked_by IN ('freeze','blast_radius')),
  freeze_id uuid REFERENCES nyst_freezes(freeze_id),
  budget_id uuid REFERENCES nyst_blast_radius_budgets(budget_id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  decided_at timestamptz NOT NULL DEFAULT now(),
  -- One logical action is admitted at most once.
  UNIQUE (environment_id, effect_name, business_key),
  CONSTRAINT nyst_admission_block_has_cause CHECK (admitted = (blocked_by IS NULL)),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_consequence_admissions_recent ON nyst_consequence_admissions(environment_id, decided_at DESC);
-- Supports the windowed budget count read under the budget row lock.
CREATE INDEX nyst_consequence_admissions_window
  ON nyst_consequence_admissions(environment_id, effect_name, agent_id, decided_at DESC) WHERE admitted;
-- The DECISION is immutable; only the action back-reference may be written,
-- and only once, from NULL.
CREATE OR REPLACE FUNCTION nyst_guard_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'nyst: consequence admissions are immutable'; END IF;
  IF NEW.admission_id <> OLD.admission_id OR NEW.admitted <> OLD.admitted
     OR NEW.blocked_by IS DISTINCT FROM OLD.blocked_by OR NEW.reason <> OLD.reason
     OR NEW.effect_name <> OLD.effect_name OR NEW.business_key <> OLD.business_key
     OR NEW.environment_id <> OLD.environment_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.decided_at <> OLD.decided_at OR OLD.action_id IS NOT NULL THEN
    RAISE EXCEPTION 'nyst: consequence admissions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nyst_consequence_admissions_immutable
  BEFORE UPDATE OR DELETE ON nyst_consequence_admissions
  FOR EACH ROW EXECUTE FUNCTION nyst_guard_admission();

-- =====================================================================
-- PHASE 12 — policy templates.
--
-- Templates create standard versioned policies through the EXISTING policy
-- engine. There is no second policy engine and no policy DSL.
-- =====================================================================
ALTER TABLE nyst_policy_versions ADD COLUMN template_id text
  CHECK (template_id IS NULL OR template_id IN ('access_revocation','financial_action','high_risk_production','custom'));
