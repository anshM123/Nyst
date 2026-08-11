-- Nyst v0.2.2 — Phase 4: control-plane idempotency.
--
-- A browser double-click, a proxy retry, or an impatient operator must not be
-- able to create two API keys, two policy versions, two Failure Lab runs, or
-- two recovery authorizations.
--
-- Deliberately NOT applied to consequential SDK calls. `POST /v1/actions`
-- already derives its logical identity from (environment, business key) and is
-- protected by the engine's dispatch-before-consequence machinery. Layering a
-- second dedupe mechanism over a consequential action would create two
-- competing definitions of "the same action", which is exactly the confusion
-- Nyst exists to eliminate.

CREATE TABLE nyst_idempotency_keys (
  idempotency_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- The caller-supplied key, scoped to the tenant AND to the operation, so the
  -- same key cannot be replayed against a different endpoint.
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  -- Hash of the canonical request body. A key reused with DIFFERENT parameters
  -- is a caller bug and must be rejected, never silently served the old result.
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','completed')),
  response jsonb,
  response_status integer CHECK (response_status IS NULL OR (response_status BETWEEN 100 AND 599)),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Bounded retention; a key is replayable for 24 hours.
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (environment_id, operation, idempotency_key),
  CONSTRAINT nyst_idempotency_completed_has_response
    CHECK (status <> 'completed' OR (response IS NOT NULL AND response_status IS NOT NULL AND completed_at IS NOT NULL)),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_idempotency_keys_expiry ON nyst_idempotency_keys(expires_at);

-- The stored request hash pins the meaning of the key and can never change.
CREATE OR REPLACE FUNCTION nyst_guard_idempotency_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.operation <> OLD.operation
     OR NEW.request_hash <> OLD.request_hash
     OR NEW.environment_id <> OLD.environment_id
     OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'nyst: idempotency identity is immutable';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'nyst: a completed idempotent result is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nyst_idempotency_keys_identity BEFORE UPDATE ON nyst_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION nyst_guard_idempotency_record();
