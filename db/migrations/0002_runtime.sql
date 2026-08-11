-- Nyst Gate 2 durable runtime state.
BEGIN;

CREATE TABLE IF NOT EXISTS outcome_runtime (
    action_id                  uuid PRIMARY KEY REFERENCES outcome_actions(action_id),
    dispatch_status            text NOT NULL CHECK (dispatch_status IN (
                                  'not_started','claimed','attempted','definitely_not_sent')),
    dispatch_attempts          integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
    dispatch_claim_token       uuid,
    compensation_claim_token   uuid,
    compensation_attempts      integer NOT NULL DEFAULT 0 CHECK (compensation_attempts >= 0),
    resolution_sequence        integer NOT NULL DEFAULT 0 CHECK (resolution_sequence >= 0),
    next_check_at              timestamptz,
    last_effect_state          text CHECK (last_effect_state IS NULL OR last_effect_state IN (
                                  'verified','not_applied','pending','compensated',
                                  'satisfied_unattributed','unprovable')),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outcome_runtime_claim_consistency CHECK (
      (dispatch_status = 'claimed' AND dispatch_claim_token IS NOT NULL)
      OR (dispatch_status <> 'claimed' AND dispatch_claim_token IS NULL)
    )
);

-- Deterministic current-resolution ordering is logical, never wall-clock-only.
ALTER TABLE outcome_resolutions
  ADD COLUMN IF NOT EXISTS resolution_sequence integer;

CREATE UNIQUE INDEX IF NOT EXISTS outcome_resolutions_action_sequence_uq
  ON outcome_resolutions(action_id, resolution_sequence)
  WHERE resolution_sequence IS NOT NULL;

-- Provider events have delivery identity. Re-delivery must not strengthen truth.
CREATE UNIQUE INDEX IF NOT EXISTS outcome_evidence_provider_event_uq
  ON outcome_evidence(action_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

COMMIT;
