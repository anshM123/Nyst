-- Outcome Phase 1 schema (Gate 1 hardened, v3).
-- Invariants enforced IN THE DATABASE, not only in application code:
--   * one logical action per (effect_name, business_key)   -> unique index
--   * effect state is a closed 6-value set                 -> CHECK constraint
--   * internal lifecycle is a separate closed set          -> CHECK constraint
--   * no dispatch without persisted execution identity     -> CHECK constraint
--   * evidence is append-only                              -> UPDATE/DELETE-blocking trigger
--   * signed resolutions are append-only                   -> UPDATE/DELETE-blocking trigger
--   * per-action deterministic evidence order              -> (action_id, seq) unique
--   * evidence supersedes only SAME-action evidence        -> composite foreign key
--
-- NOTE: this file is cross-checked against src/store/postgresStore.ts by
-- scripts/checkSchemaSync.ts (run in `npm test`). If you touch either side,
-- the check fails until they agree again.

BEGIN;

CREATE TABLE IF NOT EXISTS outcome_actions (
    action_id        uuid PRIMARY KEY,
    effect_name      text NOT NULL CHECK (length(effect_name) BETWEEN 1 AND 200),
    business_key     text NOT NULL CHECK (length(business_key) BETWEEN 1 AND 500),
    input_hash       text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
    input            jsonb NOT NULL,
    spec_version     text NOT NULL,
    internal_state   text NOT NULL CHECK (internal_state IN (
                        'intent_recorded','prepared','dispatching','observing',
                        'reconciling','resolved','abandoned_before_dispatch')),
    -- Exact provider-operation identity (correlation + idempotency material),
    -- persisted at `prepared`, BEFORE any mutation may be dispatched.
    dispatch_plan    jsonb,
    -- Day-1 context metadata (AI fields nullable; never raw credentials)
    value_minor_units   bigint,
    value_currency      char(3),
    risk_magnitude      text,
    workload_id         text,
    workload_version    text,
    model_identity      text,
    model_config_hash   text,
    credential_ref      text,
    approval_required   boolean NOT NULL DEFAULT false,
    approval_fired      boolean NOT NULL DEFAULT false,
    approval_reference  text,
    created_at          timestamptz NOT NULL,
    created_clock       jsonb NOT NULL,
    -- Execution identity must be durable BEFORE dispatch: once the lifecycle
    -- has reached (or passed) `dispatching`, a dispatch plan must exist.
    CONSTRAINT outcome_actions_dispatch_needs_plan CHECK (
        internal_state NOT IN ('dispatching','observing','reconciling','resolved')
        OR dispatch_plan IS NOT NULL
    )
);

-- One logical action per (effect_name, business_key). Same identity + same
-- input hash resolves to the existing row; a different input hash is an
-- application-level InputCollisionError detected after the conflict.
CREATE UNIQUE INDEX IF NOT EXISTS outcome_actions_identity_uq
    ON outcome_actions (effect_name, business_key);

CREATE TABLE IF NOT EXISTS outcome_evidence (
    evidence_id             uuid PRIMARY KEY,
    action_id               uuid NOT NULL REFERENCES outcome_actions(action_id),
    seq                     integer NOT NULL CHECK (seq >= 1),
    evidence_schema_version integer NOT NULL,
    source                  text NOT NULL,
    verification_method     text NOT NULL CHECK (verification_method IN (
                              'provider_read_back','event_correlation','response_inspection',
                              'downstream_check','absence_window_probe','manual_review','none')),
    kind                    text NOT NULL CHECK (kind IN (
                              'provider_response','provider_read','provider_event',
                              'downstream_state','transport_error','compensation_confirmation',
                              'absence_probe','manual_attestation')),
    strength                text NOT NULL CHECK (strength IN (
                              'authoritative','corroborative','circumstantial','transport_only')),
    -- Normalized: what this evidence, on its face, says about the INTENDED effect.
    observed_disposition    text NOT NULL CHECK (observed_disposition IN (
                              'effect_present','effect_absent','indeterminate')),
    -- Normalized: whether this evidence itself ties the observation to THIS action.
    attribution             text NOT NULL CHECK (attribution IN (
                              'attributed','unattributed','indeterminate')),
    provider_object_id      text,
    provider_event_id       text,
    observed_at             timestamptz NOT NULL,
    provider_timestamp      timestamptz,
    payload                 jsonb NOT NULL,
    payload_hash            text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
    correlation             jsonb NOT NULL,
    signing                 jsonb,
    clock                   jsonb NOT NULL,
    supersedes_evidence_id  uuid REFERENCES outcome_evidence(evidence_id),
    UNIQUE (action_id, seq),
    UNIQUE (evidence_id, action_id),
    -- Evidence may only supersede evidence of the SAME action.
    CONSTRAINT outcome_evidence_supersedes_same_action_fk
        FOREIGN KEY (supersedes_evidence_id, action_id)
        REFERENCES outcome_evidence (evidence_id, action_id)
);

-- Evidence is APPEND-ONLY. History is never rewritten; corrections append a
-- new row with supersedes_evidence_id.
CREATE OR REPLACE FUNCTION outcome_forbid_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outcome_evidence_no_update ON outcome_evidence;
CREATE TRIGGER outcome_evidence_no_update
    BEFORE UPDATE OR DELETE ON outcome_evidence
    FOR EACH ROW EXECUTE FUNCTION outcome_forbid_change();

CREATE TABLE IF NOT EXISTS outcome_resolutions (
    resolution_id       uuid PRIMARY KEY,
    resolution_version  integer NOT NULL,
    action_id           uuid NOT NULL REFERENCES outcome_actions(action_id),
    effect_name         text NOT NULL,
    business_key        text NOT NULL,
    input_hash          text NOT NULL,
    -- AXIS 1: effect state (closed six-value set — do not add a seventh)
    effect_state        text NOT NULL CHECK (effect_state IN (
                          'verified','not_applied','pending','compensated',
                          'satisfied_unattributed','unprovable')),
    -- AXIS 2: control decision — central Outcome semantics, first-class
    -- checked columns for direct querying (metrics, audits), in addition to
    -- the structured jsonb document.
    primary_directive        text NOT NULL CHECK (primary_directive IN (
                               'continue','retry','do_not_retry','hold','compensate','escalate')),
    retry_disposition        text NOT NULL CHECK (retry_disposition IN (
                               'allowed','forbidden','unknown')),
    continuation_disposition text NOT NULL CHECK (continuation_disposition IN (
                               'allowed','blocked','conditional')),
    recovery_disposition     text NOT NULL CHECK (recovery_disposition IN (
                               'none','compensate','escalate')),
    effect_detail       jsonb NOT NULL,   -- provider refs, evidence refs, methods, strength
    control_decision    jsonb NOT NULL,
    context             jsonb NOT NULL,
    created_at          timestamptz NOT NULL,
    resolved_at         timestamptz NOT NULL,
    clock               jsonb NOT NULL,
    signature           jsonb,
    full_document       jsonb NOT NULL    -- the exact signed OutcomeResolution
);

CREATE INDEX IF NOT EXISTS outcome_resolutions_action_idx
    ON outcome_resolutions (action_id, resolved_at);

-- Signed historical resolutions are IMMUTABLE, exactly like evidence.
DROP TRIGGER IF EXISTS outcome_resolutions_no_update ON outcome_resolutions;
CREATE TRIGGER outcome_resolutions_no_update
    BEFORE UPDATE OR DELETE ON outcome_resolutions
    FOR EACH ROW EXECUTE FUNCTION outcome_forbid_change();

COMMIT;
