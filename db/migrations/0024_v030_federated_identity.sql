-- Nyst v0.3.0 — Phases 35, 36. FEDERATED IDENTITY.
--
-- Google Sign-In, and a generic OIDC shape underneath it so an enterprise
-- provider is a configuration rather than a second implementation.
--
-- THE IDENTITY MODEL, and why it is not email.
--
-- A provider's stable subject identifier is the identity. An email address is
-- a LABEL: it can be reassigned, an ex-employee's address can be given to
-- someone new, and a provider can change what it reports. Keying an account on
-- email means whoever holds an address today inherits whatever the previous
-- holder could do. So the durable key is (provider, provider_subject), and the
-- email is recorded only as what was verified at the moment of linking.

CREATE TABLE nyst_federated_identities (
  federated_identity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nyst_users(user_id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  provider text NOT NULL CHECK (provider IN ('google','oidc')),
  -- For generic OIDC: which configured provider this came from.
  provider_config_id uuid,
  -- The provider's STABLE subject. Never an email.
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  -- What the provider asserted, verified, at the moment of linking. A record
  -- of a past fact, not a lookup key.
  email_at_link text NOT NULL CHECK (length(email_at_link) BETWEEN 3 AND 320),
  email_verified_at_link boolean NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disconnected_at timestamptz,
  disconnected_by uuid REFERENCES nyst_users(user_id),
  -- One provider subject maps to exactly one Nyst user, forever. Two users
  -- claiming the same Google account is either a mistake or a takeover.
  UNIQUE (provider, provider_subject),
  -- And one user has at most one live identity per provider.
  CHECK ((disconnected_at IS NULL) OR (disconnected_by IS NOT NULL))
);

CREATE UNIQUE INDEX nyst_federated_identities_live
  ON nyst_federated_identities (user_id, provider, coalesce(provider_config_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE disconnected_at IS NULL;

CREATE INDEX nyst_federated_identities_user ON nyst_federated_identities (user_id) WHERE disconnected_at IS NULL;

-- The subject binding is historical truth. Re-linking after a disconnect
-- writes a new row; it never edits the old one.
CREATE OR REPLACE FUNCTION nyst_federated_identities_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_federated_identities is append-only: disconnect the identity instead of deleting it';
  END IF;
  IF NEW.federated_identity_id <> OLD.federated_identity_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.provider <> OLD.provider
     OR NEW.provider_subject <> OLD.provider_subject
     OR NEW.email_at_link <> OLD.email_at_link
     OR NEW.email_verified_at_link <> OLD.email_verified_at_link
     OR NEW.linked_at <> OLD.linked_at THEN
    RAISE EXCEPTION 'a federated identity binding is immutable: only last_login_at and disconnection may be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_federated_identities_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_federated_identities
  FOR EACH ROW EXECUTE FUNCTION nyst_federated_identities_immutable();

-- Single-use login attempts, for nonce and state replay protection.
--
-- Created before the redirect, consumed exactly once on the callback. A state
-- value that has already been used, or that nobody issued, is refused — which
-- is what stops both a replayed callback and a login CSRF where an attacker
-- gets a victim's browser to complete THEIR sign-in.
CREATE TABLE nyst_login_attempts (
  login_attempt_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google','oidc')),
  provider_config_id uuid,
  state text NOT NULL UNIQUE CHECK (length(state) BETWEEN 32 AND 128),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 32 AND 128),
  -- Where to go afterwards. A RELATIVE path only; the check below is what
  -- stops an open redirect.
  redirect_to text NOT NULL DEFAULT '/' CHECK (
    redirect_to ~ '^/[A-Za-z0-9_/-]*$' AND redirect_to !~ '^//'
  ),
  -- Set when this attempt is a LINK to an already-authenticated account
  -- rather than a fresh sign-in. Linking requires an existing session.
  linking_user_id uuid REFERENCES nyst_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  -- Ten minutes is generous for a redirect round-trip.
  CHECK (expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX nyst_login_attempts_open ON nyst_login_attempts (expires_at) WHERE consumed_at IS NULL;

-- Optional enterprise OIDC providers. Google does not depend on this table.
CREATE TABLE nyst_oidc_providers (
  provider_config_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  issuer text NOT NULL CHECK (issuer ~ '^https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 4 AND 255),
  -- Opaque reference. The secret itself is never stored.
  client_secret_ref text NOT NULL CHECK (
    length(client_secret_ref) BETWEEN 8 AND 300
    AND client_secret_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
  ),
  jwks_uri text NOT NULL CHECK (jwks_uri ~ '^https://'),
  -- Whether an unverified email may sign in. Default false.
  require_verified_email boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES nyst_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (organization_id, issuer)
);
