-- Nyst v0.3.3 — CUSTOMER-SUPPLIED PROVIDER CREDENTIALS.
--
-- Until now every credential reference had to be `env:SOMETHING`, a process
-- environment variable on the host Nyst runs on. That is a perfectly good
-- posture for the operator's own deployment and it means a self-serve customer
-- can never connect a provider at all: they cannot set an environment variable
-- on somebody else's server. Nyst was multi-tenant in its data model and
-- single-tenant in its onboarding.
--
-- This table holds credentials the CUSTOMER supplied, encrypted with
-- AES-256-GCM under a key held by the deployment and never by the database.
--
-- WHAT IS DELIBERATELY ABSENT FROM THIS TABLE.
--
-- There is no `value`, no `last_four`, and no `hint` column. A partial secret
-- is a secret; four characters of a token narrows an offline search and buys
-- the customer nothing that the keyed fingerprint does not buy safely.
--
-- `fingerprint` is a TRUNCATED HMAC under the same deployment key — not a bare
-- digest — so it identifies which credential is loaded without being
-- guessable offline from a stolen database alone.
--
-- THE PARTIAL UNIQUE INDEX IS THE LOAD-BEARING PART.
--
-- One LIVE credential per (organization, project, environment, provider).
-- Without it, two live rows could exist and "which token did Nyst use for this
-- action" becomes unanswerable — a question every incident review asks. The
-- application supersedes on write; this makes a bug in that logic a constraint
-- violation rather than a silent ambiguity.

CREATE TABLE IF NOT EXISTS nyst_tenant_credentials (
  credential_id    uuid PRIMARY KEY,
  organization_id  uuid NOT NULL,
  project_id       uuid NOT NULL,
  environment_id   uuid NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('github','okta','stripe')),

  -- AES-256-GCM. The tenant scope is bound into the AAD, so a row moved to
  -- another organization fails to decrypt instead of decrypting into the wrong
  -- customer's hands.
  ciphertext       bytea NOT NULL,
  iv               bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag         bytea NOT NULL CHECK (octet_length(auth_tag) = 16),

  -- Truncated keyed digest. Safe to render, safe to log, safe to export.
  fingerprint      text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),

  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoke_reason    text,

  -- A credential is either live or it carries the reason it stopped being so.
  -- Rotation history is retained on purpose: "when did this change" is an
  -- incident question, and a DELETE would destroy the answer.
  CONSTRAINT nyst_tenant_credentials_revocation_explained
    CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL),

  -- Guards against a bug writing an empty value under a valid-looking tag.
  CONSTRAINT nyst_tenant_credentials_ciphertext_present
    CHECK (octet_length(ciphertext) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS nyst_tenant_credentials_one_live
  ON nyst_tenant_credentials (organization_id, project_id, environment_id, provider)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS nyst_tenant_credentials_by_scope
  ON nyst_tenant_credentials (organization_id, environment_id, provider, created_at DESC);

-- REFUSE TO UPDATE THE SECRET IN PLACE.
--
-- A credential row is append-only in its ciphertext. Rotation writes a NEW row
-- and revokes the old one, so the history of which credential was live at which
-- time survives. Allowing UPDATE on the ciphertext would let a rotation
-- silently rewrite the past, and every receipt naming that reference would
-- then attribute an action to a credential that is no longer the one used.
CREATE OR REPLACE FUNCTION nyst_tenant_credentials_immutable_secret() RETURNS trigger AS $$
BEGIN
  IF NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
     OR NEW.iv IS DISTINCT FROM OLD.iv
     OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
     OR NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION
      'A stored credential is immutable. Rotate by storing a new credential, which revokes this one; '
      'rewriting it in place would make every receipt naming this reference attribute an action to a '
      'credential that is not the one that was used.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nyst_tenant_credentials_immutable ON nyst_tenant_credentials;
CREATE TRIGGER nyst_tenant_credentials_immutable
  BEFORE UPDATE ON nyst_tenant_credentials
  FOR EACH ROW EXECUTE FUNCTION nyst_tenant_credentials_immutable_secret();
