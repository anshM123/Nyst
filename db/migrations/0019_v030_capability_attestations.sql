-- Nyst v0.3.0 — Phase 1D / Phase 7. Capability attestations.
--
-- A read-only preflight can never VERIFY a write capability without performing
-- a write, and invariant I20 forbids that absolutely. Where a provider
-- publishes its own authorization metadata (GitHub token scopes, Okta granted
-- scopes) Nyst reads it. Where a provider publishes nothing (Stripe restricted
-- keys report no scope list) the capability would stay AVAILABLE forever and
-- the workload could never be Ready.
--
-- An operator may therefore record an explicit attestation: "this credential
-- holds this capability". Nyst stores it as a CLAIM — with an author, a
-- timestamp, and a mandatory justification — never as an observation. Every
-- surface that counts an attestation says, in words, that Nyst did not observe
-- it. An observation always wins over an attestation; the attestation is only
-- consulted when nothing was observed.

CREATE TABLE nyst_capability_attestations (
  attestation_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','okta','stripe')),
  -- A Nyst capability token, never a provider scope string and never a secret.
  capability text NOT NULL CHECK (
    capability ~ '^[a-z_]+:[a-z_]+:[a-z_]+$' AND length(capability) BETWEEN 5 AND 120
  ),
  -- Who made the claim. A real user in this organization, not a service.
  attested_by uuid NOT NULL REFERENCES nyst_users(user_id),
  -- Why. A claim without a reason is not auditable.
  justification text NOT NULL CHECK (length(btrim(justification)) BETWEEN 10 AND 1000),
  attested_at timestamptz NOT NULL DEFAULT now(),
  -- Withdrawal is a new fact, not a deletion: the row stays, forever.
  revoked_at timestamptz,
  revoked_by uuid REFERENCES nyst_users(user_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= attested_at),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

-- At most one LIVE attestation per capability per environment. Withdrawn rows
-- are unconstrained, so the history is complete.
CREATE UNIQUE INDEX nyst_capability_attestations_live
  ON nyst_capability_attestations (environment_id, provider, capability)
  WHERE revoked_at IS NULL;

CREATE INDEX nyst_capability_attestations_scope
  ON nyst_capability_attestations (organization_id, project_id, environment_id, provider);

-- Attestations are append-only. Correcting one means revoking it and writing a
-- new one, so the record of what was believed, and when, survives.
CREATE OR REPLACE FUNCTION nyst_capability_attestations_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_capability_attestations is append-only: revoke the attestation instead of deleting it';
  END IF;
  IF NEW.attestation_id <> OLD.attestation_id
     OR NEW.environment_id <> OLD.environment_id
     OR NEW.provider <> OLD.provider
     OR NEW.capability <> OLD.capability
     OR NEW.attested_by <> OLD.attested_by
     OR NEW.justification <> OLD.justification
     OR NEW.attested_at <> OLD.attested_at THEN
    RAISE EXCEPTION 'nyst_capability_attestations is append-only: only revocation may be recorded';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'this capability attestation was already withdrawn';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_capability_attestations_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_capability_attestations
  FOR EACH ROW EXECUTE FUNCTION nyst_capability_attestations_immutable();
