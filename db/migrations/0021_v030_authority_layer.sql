-- Nyst v0.3.0 — Phases 28-31. THE AUTHORITY LAYER.
--
-- AUTHORITY answers a question neither of the other layers does: what may this
-- Agent do? Not "what happened" (EFFECT), not "what became true" (OUTCOME).
--
-- Everything here narrows. Effective authority is an INTERSECTION of every
-- constraint that applies, and there is no record in this file that can grant
-- an Agent more than the EffectSpec and the customer's policy already allow.
-- An exception is narrower authority made temporarily available under an
-- explicit human decision — never a wider envelope, and never a way to
-- overwrite what Nyst observed.

/* ========================================================== AUTONOMY LINE */

-- NOT a trust score. There is no number between 0 and 100 anywhere in this
-- table, because a single scalar cannot express "this agent may revoke GitHub
-- access on its own but a grant needs a human, and it may never touch AWS".
--
-- Each row is one deterministic rule in a multidimensional envelope. The most
-- specific matching rule wins, and the match is explainable field by field.
CREATE TABLE nyst_autonomy_rules (
  autonomy_rule_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- Every dimension is optional. NULL means "any", and a rule with more
  -- non-NULL dimensions is more specific.
  agent_id uuid,
  effect_name text,
  outcome_spec text,
  resource_class text,
  -- Consequence bounds. NULL means this rule places no monetary bound.
  max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  max_actions_per_window integer CHECK (max_actions_per_window IS NULL OR max_actions_per_window >= 0),
  max_amount_minor_per_window bigint CHECK (max_amount_minor_per_window IS NULL OR max_amount_minor_per_window >= 0),
  window_seconds integer CHECK (window_seconds IS NULL OR window_seconds BETWEEN 60 AND 86400),
  -- Only permit this when the effect is reversible, where that is known.
  requires_reversible boolean NOT NULL DEFAULT false,
  -- Refuse while any unresolved incident covers this scope.
  requires_no_open_incident boolean NOT NULL DEFAULT false,
  -- Refuse unless the named OutcomeSpec is currently SATISFIED for the subject.
  requires_outcome_satisfied text,
  -- The verdict. Exactly three, and none of them is a score.
  disposition text NOT NULL CHECK (disposition IN ('autonomous','human','disabled')),
  -- Why this rule exists, in the words of whoever set it.
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 5 AND 1000),
  created_by uuid NOT NULL REFERENCES nyst_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((max_amount_minor IS NULL AND max_amount_minor_per_window IS NULL) OR currency IS NOT NULL),
  CHECK ((max_actions_per_window IS NULL AND max_amount_minor_per_window IS NULL) OR window_seconds IS NOT NULL),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);

CREATE INDEX nyst_autonomy_rules_scope
  ON nyst_autonomy_rules (environment_id, agent_id, effect_name) WHERE disabled_at IS NULL;

/* ==================================================== EXCEPTIONS, APPROVALS */

-- A first-class, auditable, time-limited authority record.
--
-- Read the CHECK constraints as the product statement: there is no exception
-- kind that marks something verified, and none that declares an outcome
-- satisfied. An exception can authorize CONTINUATION despite an unsatisfied or
-- indeterminate outcome — with an actor, a reason and an expiry attached — and
-- the outcome itself stays exactly as observed. "Jane authorized continuation
-- while the outcome was INDETERMINATE" is a true and useful sentence. "Jane
-- marked it satisfied" is a lie, and this schema cannot store it.
CREATE TABLE nyst_authority_exceptions (
  exception_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'exception_rule',        -- a standing narrow carve-out
    'temporary_grant',       -- a time-boxed widening of an existing bound
    'human_approval',        -- a person approving one specific pending action
    'emergency_policy',      -- a declared incident posture
    'break_glass'            -- the loudest possible door, fully attributed
  )),
  -- Scope. Every dimension NULL-able, but a break_glass with no scope at all
  -- is refused below: an unscoped emergency authority is not an exception.
  agent_id uuid,
  effect_name text,
  outcome_spec text,
  outcome_instance_id uuid REFERENCES nyst_outcome_instances(outcome_instance_id),
  action_id uuid,
  -- What it authorizes. Deliberately a closed set.
  authorizes text NOT NULL CHECK (authorizes IN (
    'continuation_despite_unsatisfied_outcome',
    'continuation_despite_indeterminate_outcome',
    'amount_above_autonomy_line',
    'action_requiring_human_approval'
  )),
  -- For amount exceptions only.
  max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor > 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  -- Who, why, and until when. All three are mandatory.
  actor_user_id uuid NOT NULL REFERENCES nyst_users(user_id),
  actor_role text NOT NULL CHECK (length(btrim(actor_role)) BETWEEN 2 AND 120),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  -- An external reference: an incident id, a ticket, a change record.
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 200),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES nyst_users(user_id),
  revocation_reason text,
  CHECK (expires_at > issued_at),
  -- Nothing here lasts more than a day. A permanent exception is a policy
  -- change, and it belongs in a policy version where it is visible.
  CHECK (expires_at <= issued_at + interval '24 hours'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revocation_reason IS NOT NULL),
  -- An amount exception needs an amount; a continuation exception must not
  -- carry one, because it is not about money.
  CHECK ((authorizes = 'amount_above_autonomy_line') = (max_amount_minor IS NOT NULL)),
  CHECK ((max_amount_minor IS NULL) = (currency IS NULL)),
  -- Break glass must name something. An unscoped one is not an exception.
  CHECK (kind <> 'break_glass' OR agent_id IS NOT NULL OR effect_name IS NOT NULL
         OR outcome_instance_id IS NOT NULL OR action_id IS NOT NULL),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_authority_exceptions_live
  ON nyst_authority_exceptions (environment_id, authorizes, expires_at)
  WHERE revoked_at IS NULL;

-- Immutable in audit. Revocation is the only permitted change, and it is a new
-- fact rather than an edit.
CREATE OR REPLACE FUNCTION nyst_authority_exceptions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_authority_exceptions is immutable: revoke the exception instead of deleting it';
  END IF;
  IF NEW.exception_id <> OLD.exception_id OR NEW.kind <> OLD.kind OR NEW.authorizes <> OLD.authorizes
     OR NEW.actor_user_id <> OLD.actor_user_id OR NEW.reason <> OLD.reason
     OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.max_amount_minor IS DISTINCT FROM OLD.max_amount_minor
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.effect_name IS DISTINCT FROM OLD.effect_name
     OR NEW.outcome_instance_id IS DISTINCT FROM OLD.outcome_instance_id THEN
    RAISE EXCEPTION 'nyst_authority_exceptions is immutable: only revocation may be recorded';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'this authority exception was already revoked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_authority_exceptions_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_authority_exceptions
  FOR EACH ROW EXECUTE FUNCTION nyst_authority_exceptions_immutable();

/* ======================================================= CONTINUATION GRANT */

-- A signed, narrow, expiring permission for ONE dependent consequence.
--
-- The grant pins everything that made it valid: the outcome, the exact
-- contract version, the evaluation sequence the verdict came from, and the
-- specific effects and resources it covers. Any of those moving invalidates
-- it, which is what stops a grant issued for a healthy world from being used
-- after the world changed.
CREATE TABLE nyst_continuation_grants (
  grant_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_id uuid,
  outcome_instance_id uuid NOT NULL REFERENCES nyst_outcome_instances(outcome_instance_id),
  outcome_contract_id uuid NOT NULL REFERENCES nyst_outcome_contracts(outcome_contract_id),
  contract_version integer NOT NULL,
  -- The evaluation this grant rests on. A newer evaluation supersedes it.
  evaluation_sequence bigint NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('satisfied','unsatisfied','indeterminate')),
  -- The exception that permitted a non-satisfied grant, where there was one.
  exception_id uuid REFERENCES nyst_authority_exceptions(exception_id),
  -- The invariants and facts that were true when it was issued.
  required_invariants jsonb NOT NULL,
  facts_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Exactly which effects and resources this permits. Never "everything".
  permitted_effects text[] NOT NULL CHECK (array_length(permitted_effects, 1) BETWEEN 1 AND 20),
  resource_scope text[] NOT NULL CHECK (array_length(resource_scope, 1) BETWEEN 1 AND 50),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES nyst_users(user_id),
  signature text NOT NULL,
  key_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > issued_at),
  -- No broad permanent grants. One hour is already generous for a permission
  -- that rests on an observation of a mutable external system.
  CHECK (expires_at <= issued_at + interval '1 hour'),
  -- A grant on a non-satisfied outcome REQUIRES a named human exception.
  CHECK (verdict = 'satisfied' OR exception_id IS NOT NULL),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_continuation_grants_live
  ON nyst_continuation_grants (environment_id, outcome_instance_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION nyst_continuation_grants_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_continuation_grants is immutable: revoke the grant instead of deleting it';
  END IF;
  IF NEW.grant_id <> OLD.grant_id OR NEW.outcome_instance_id <> OLD.outcome_instance_id
     OR NEW.contract_version <> OLD.contract_version OR NEW.evaluation_sequence <> OLD.evaluation_sequence
     OR NEW.verdict <> OLD.verdict OR NEW.signature <> OLD.signature OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.permitted_effects IS DISTINCT FROM OLD.permitted_effects
     OR NEW.resource_scope IS DISTINCT FROM OLD.resource_scope
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'nyst_continuation_grants is immutable: only consumption and revocation may be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_continuation_grants_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_continuation_grants
  FOR EACH ROW EXECUTE FUNCTION nyst_continuation_grants_immutable();

/* ============================================== AUTHORITY DECISION HISTORY */

-- Every canonical authority evaluation, recorded. An operator asking "why was
-- this refused at 03:14?" gets the actual decision, with every input that
-- produced it, rather than a reconstruction.
CREATE TABLE nyst_authority_decisions (
  authority_decision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_id uuid,
  effect_name text NOT NULL,
  outcome_instance_id uuid REFERENCES nyst_outcome_instances(outcome_instance_id),
  action_id uuid,
  disposition text NOT NULL CHECK (disposition IN ('allowed','held','blocked')),
  -- Each contributing layer's answer, so no one has to guess which one bit.
  reasons jsonb NOT NULL,
  controlling_policy_version_id uuid,
  autonomy_rule_id uuid REFERENCES nyst_autonomy_rules(autonomy_rule_id),
  freeze_id uuid,
  budget_id uuid,
  exception_id uuid REFERENCES nyst_authority_exceptions(exception_id),
  grant_id uuid REFERENCES nyst_continuation_grants(grant_id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_authority_decisions_scope
  ON nyst_authority_decisions (environment_id, decided_at DESC);

CREATE OR REPLACE FUNCTION nyst_authority_decisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'nyst_authority_decisions is append-only: a decision is a record of what was decided';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_authority_decisions_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_authority_decisions
  FOR EACH ROW EXECUTE FUNCTION nyst_authority_decisions_immutable();
