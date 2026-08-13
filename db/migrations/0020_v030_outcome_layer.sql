-- Nyst v0.3.0 — Phases 18-22, 27. THE OUTCOME LAYER.
--
-- Three layers must never blur:
--
--   AUTHORITY  what may this Agent do?
--   EFFECT     what happened to this operation?
--   OUTCOME    what became true in the real world?
--
-- Everything before v0.3.0 lived in the EFFECT layer. "The GitHub permission
-- change was verified" is an effect fact, and it is not the same claim as
-- "Alice no longer has production access" — she may still have it through a
-- team she is a member of. An action can be perfectly verified while the
-- outcome the customer actually cares about is false.
--
-- So OUTCOME gets its own tables, its own three-valued verdict, and its own
-- evidence. It is deliberately NOT a workflow engine and NOT a CMDB: it holds
-- only the facts required to decide whether the world permits consequential
-- continuation.

/* ============================================================ CONTRACTS */

-- An OutcomeContract is an IMMUTABLE configured version of an OutcomeSpec for
-- one protected workflow. Historical instances pin the exact version, so the
-- answer to "what did Nyst require of this offboarding in March?" survives
-- every later edit.
--
-- There is no arbitrary code here. `required_invariants` and
-- `optional_invariants` hold declarative invariant definitions evaluated by a
-- small typed engine with a fixed operator set. No JavaScript, no expression
-- language, no LLM anywhere in the safety path.
CREATE TABLE nyst_outcome_contracts (
  outcome_contract_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- Which class of real-world condition this establishes, e.g. employee_offboarding.
  outcome_spec text NOT NULL CHECK (outcome_spec ~ '^[a-z][a-z0-9_]{2,80}$'),
  outcome_spec_version text NOT NULL CHECK (length(outcome_spec_version) BETWEEN 3 AND 60),
  contract_version integer NOT NULL CHECK (contract_version >= 1),
  -- Optional narrowing to one Agent. NULL means every Agent in the environment.
  agent_id uuid,
  -- What a subject looks like: {"person_email": "string", "github_login": "string"}.
  subject_schema jsonb NOT NULL,
  -- The sentence a human reads. Not decorative: it is what the receipt asserts.
  desired_outcome_statement text NOT NULL CHECK (length(btrim(desired_outcome_statement)) BETWEEN 20 AND 1000),
  required_invariants jsonb NOT NULL CHECK (jsonb_typeof(required_invariants) = 'array'),
  optional_invariants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(optional_invariants) = 'array'),
  -- Which evidence sources are acceptable, and how fresh a fact must be.
  evidence_requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_seconds integer NOT NULL CHECK (freshness_seconds BETWEEN 60 AND 2592000),
  -- Capability tokens every required invariant depends on being observable.
  capability_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which EffectSpecs this outcome depends on, in order.
  effect_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 60 AND 2592000),
  exception_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  remediation_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  continuation_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES nyst_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  CHECK (retired_at IS NULL OR activated_at IS NOT NULL),
  CHECK (retired_at IS NULL OR retired_at >= activated_at),
  -- At least one required invariant. A contract that requires nothing would be
  -- SATISFIED the moment it was created, which is worse than having no contract.
  CHECK (jsonb_array_length(required_invariants) >= 1),
  UNIQUE (environment_id, outcome_spec, contract_version),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);

CREATE INDEX nyst_outcome_contracts_scope ON nyst_outcome_contracts (environment_id, outcome_spec, contract_version DESC);

-- Contracts are immutable once activated. Changing one means writing a new
-- version, because instances that ran under the old one must keep their meaning.
CREATE OR REPLACE FUNCTION nyst_outcome_contracts_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_outcome_contracts is immutable: retire the contract and create a new version';
  END IF;
  IF OLD.activated_at IS NOT NULL AND (
       NEW.required_invariants IS DISTINCT FROM OLD.required_invariants
    OR NEW.optional_invariants IS DISTINCT FROM OLD.optional_invariants
    OR NEW.desired_outcome_statement IS DISTINCT FROM OLD.desired_outcome_statement
    OR NEW.evidence_requirements IS DISTINCT FROM OLD.evidence_requirements
    OR NEW.freshness_seconds IS DISTINCT FROM OLD.freshness_seconds
    OR NEW.capability_requirements IS DISTINCT FROM OLD.capability_requirements
    OR NEW.effect_dependencies IS DISTINCT FROM OLD.effect_dependencies
    OR NEW.timeout_seconds IS DISTINCT FROM OLD.timeout_seconds
    OR NEW.subject_schema IS DISTINCT FROM OLD.subject_schema
    OR NEW.outcome_spec IS DISTINCT FROM OLD.outcome_spec
    OR NEW.outcome_spec_version IS DISTINCT FROM OLD.outcome_spec_version
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
  ) THEN
    RAISE EXCEPTION 'an activated OutcomeContract is immutable: create a new contract_version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_outcome_contracts_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_outcome_contracts
  FOR EACH ROW EXECUTE FUNCTION nyst_outcome_contracts_immutable();

/* ============================================================= INSTANCES */

-- One concrete requested outcome: "offboard Alice", here, now, under exactly
-- this contract version.
CREATE TABLE nyst_outcome_instances (
  outcome_instance_id uuid PRIMARY KEY,
  outcome_contract_id uuid NOT NULL REFERENCES nyst_outcome_contracts(outcome_contract_id),
  -- Pinned, so a later contract version cannot retroactively change what this
  -- instance was required to establish.
  contract_version integer NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  agent_id uuid,
  -- The subject, matching the contract's subject_schema.
  subject jsonb NOT NULL,
  -- Stable caller-supplied identity. One key = one outcome, so a retrying
  -- caller does not create a second offboarding for the same person.
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 400),
  mode text NOT NULL CHECK (mode IN ('shadow','canary','enforced')),
  -- Truth. Exactly three values, never mixed with lifecycle.
  verdict text NOT NULL DEFAULT 'indeterminate' CHECK (verdict IN ('satisfied','unsatisfied','indeterminate')),
  -- Lifecycle. Separate on purpose: "evaluating" is not a truth value.
  lifecycle text NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open','evaluating','settled','timed_out','cancelled')),
  -- What Nyst will let happen next. Never inferred from the verdict alone.
  continuation_disposition text NOT NULL DEFAULT 'hold' CHECK (continuation_disposition IN ('hold','allowed','blocked')),
  -- How much of the contract Nyst can actually see. Missing integrations
  -- reduce coverage; they never invent certainty.
  coverage_numerator integer NOT NULL DEFAULT 0 CHECK (coverage_numerator >= 0),
  coverage_denominator integer NOT NULL DEFAULT 0 CHECK (coverage_denominator >= 0),
  CHECK (coverage_numerator <= coverage_denominator),
  evidence_sequence bigint NOT NULL DEFAULT 0,
  evaluation_sequence bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  -- When the outcome first became SATISFIED. Null while it is not.
  satisfied_at timestamptz,
  completed_at timestamptz,
  CHECK (deadline_at > started_at),
  UNIQUE (environment_id, outcome_contract_id, subject_key),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
    REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id)
);

CREATE INDEX nyst_outcome_instances_scope ON nyst_outcome_instances (environment_id, lifecycle, verdict);
CREATE INDEX nyst_outcome_instances_deadline ON nyst_outcome_instances (deadline_at) WHERE lifecycle IN ('open','evaluating');

-- Atomic Actions link UNDERNEATH an outcome. The relationship is many-to-one:
-- one offboarding involves several effects.
CREATE TABLE nyst_outcome_actions (
  outcome_instance_id uuid NOT NULL REFERENCES nyst_outcome_instances(outcome_instance_id) ON DELETE CASCADE,
  action_id uuid NOT NULL,
  -- Which effect dependency this action is discharging.
  dependency_key text NOT NULL CHECK (length(dependency_key) BETWEEN 1 AND 120),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outcome_instance_id, action_id)
);

/* ============================================================ WORLD FACTS */

-- A narrow, purposeful record of something Nyst observed about the world.
--
-- Deliberately NOT a CMDB. A WorldFact exists only because some protected
-- Outcome's invariant needs it. It carries its own provenance and its own
-- expiry, because a fact about a mutable external system is a statement about
-- an instant, not a standing truth.
CREATE TABLE nyst_world_facts (
  fact_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- What the fact is about: "github:org/repo:alice", "okta:user:00u123".
  subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 400),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  -- Which property of the subject: "effective_permission", "account_status".
  property text NOT NULL CHECK (property ~ '^[a-z][a-z0-9_]{2,80}$'),
  -- The normalized typed value. {"type":"string","value":"none"} etc. Typed so
  -- the invariant engine never has to guess how to compare two values.
  value jsonb NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('string','integer','boolean','string_set','timestamp','absent')),
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  CHECK (fresh_until > observed_at),
  -- The atomic evidence record this came from, where it came from one.
  evidence_id uuid,
  -- How Nyst came to believe it.
  source_type text NOT NULL CHECK (source_type IN (
    'provider_api_read','audit_log','provider_webhook','evidence_ingest','customer_relay',
    'cloud_native','effectspec_observation')),
  -- Is this source authoritative for this property, or merely corroborative?
  -- An outcome may never be SATISFIED on corroborative evidence alone.
  authoritative boolean NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which adapter version normalized it, so a semantics change is traceable.
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 80),
  -- Supersession rather than mutation: a newer observation points back.
  supersedes uuid REFERENCES nyst_world_facts(fact_id),
  superseded_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_world_facts_lookup
  ON nyst_world_facts (environment_id, subject_ref, property, observed_at DESC)
  WHERE superseded_at IS NULL;
CREATE INDEX nyst_world_facts_supersedes ON nyst_world_facts (supersedes) WHERE supersedes IS NOT NULL;

-- Facts are historical truth. They are never edited and never deleted; a newer
-- observation supersedes an older one, and the older one remains readable
-- because "what did Nyst believe at the time, and why" is the whole product.
CREATE OR REPLACE FUNCTION nyst_world_facts_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_world_facts is append-only: supersede the fact instead of deleting it';
  END IF;
  IF NEW.fact_id <> OLD.fact_id OR NEW.subject_ref <> OLD.subject_ref OR NEW.property <> OLD.property
     OR NEW.value IS DISTINCT FROM OLD.value OR NEW.value_type <> OLD.value_type
     OR NEW.observed_at <> OLD.observed_at OR NEW.source_type <> OLD.source_type
     OR NEW.authoritative <> OLD.authoritative OR NEW.adapter_version <> OLD.adapter_version
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id THEN
    RAISE EXCEPTION 'nyst_world_facts is append-only: only supersession may be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_world_facts_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_world_facts
  FOR EACH ROW EXECUTE FUNCTION nyst_world_facts_immutable();

/* ========================================================== EVALUATIONS */

-- The evaluation queue. Follows the unified worker lease model
-- (src/product/workerLease.ts) with reclaim class `read_only`: an evaluation
-- is a pure computation over already-durable facts, so a second worker
-- repeating it is safe. Completion is fenced on the claim token so a stale
-- evaluator cannot overwrite a newer verdict.
CREATE TABLE nyst_outcome_evaluations (
  outcome_evaluation_id uuid PRIMARY KEY,
  outcome_instance_id uuid NOT NULL REFERENCES nyst_outcome_instances(outcome_instance_id) ON DELETE CASCADE,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  -- Monotonic per instance. A completion carrying an older sequence is stale.
  evaluation_sequence bigint NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','evaluating','completed','needs_review')),
  claim_token uuid,
  claimed_at timestamptz,
  claimed_until timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- The verdict this evaluation produced, once it produced one.
  verdict text CHECK (verdict IN ('satisfied','unsatisfied','indeterminate')),
  -- Per-invariant results, WorldFacts used, contradictions, missing facts.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
  CHECK (status <> 'completed' OR verdict IS NOT NULL),
  UNIQUE (outcome_instance_id, evaluation_sequence),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_outcome_evaluations_claimable
  ON nyst_outcome_evaluations (requested_at, outcome_evaluation_id)
  WHERE status IN ('requested','evaluating');

/* ============================================================= RECEIPTS */

-- A signed statement that a real-world outcome was established, resting on
-- named facts. Separate from the atomic Effect Receipt, because they assert
-- different things: one says an operation happened, the other says the world
-- is in a particular state.
CREATE TABLE nyst_outcome_receipts (
  outcome_receipt_id uuid PRIMARY KEY,
  outcome_instance_id uuid NOT NULL UNIQUE REFERENCES nyst_outcome_instances(outcome_instance_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('satisfied','unsatisfied','indeterminate')),
  -- The canonical, signed payload. Contains no credential, ever.
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  signature text NOT NULL,
  key_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE OR REPLACE FUNCTION nyst_outcome_receipts_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'nyst_outcome_receipts is immutable: a receipt is a signed statement about an instant';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_outcome_receipts_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_outcome_receipts
  FOR EACH ROW EXECUTE FUNCTION nyst_outcome_receipts_immutable();
