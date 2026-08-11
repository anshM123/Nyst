-- Gate 8: minimal multi-tenant product/control-plane model.
-- Provider credentials remain references only; reusable Nyst credentials are hashed.

CREATE TABLE nyst_organizations (
  organization_id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nyst_users (
  user_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash text NOT NULL CHECK (password_hash LIKE '$2%'),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE nyst_projects (
  project_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (project_id, organization_id)
);

CREATE TABLE nyst_environments (
  environment_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES nyst_projects(project_id, organization_id),
  UNIQUE (project_id, slug),
  UNIQUE (environment_id, project_id, organization_id)
);

CREATE TABLE nyst_integrations (
  integration_id uuid PRIMARY KEY,
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github','okta','stripe')),
  credential_ref text NOT NULL CHECK (
    length(credential_ref) BETWEEN 5 AND 300
    AND credential_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
    AND credential_ref !~ '(github_pat_|ghp_|sk_(test|live)_|rk_(test|live)_|Bearer[[:space:]])'
  ),
  configured boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  UNIQUE (environment_id, provider),
  UNIQUE (integration_id, environment_id, project_id, organization_id)
);

CREATE TABLE nyst_environment_effect_specs (
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  effect_name text NOT NULL CHECK (length(effect_name) BETWEEN 1 AND 200),
  spec_version text NOT NULL CHECK (length(spec_version) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (environment_id, effect_name),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE TABLE nyst_action_scopes (
  action_id uuid PRIMARY KEY REFERENCES outcome_actions(action_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  display_business_key text NOT NULL CHECK (length(display_business_key) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE TABLE nyst_offboarding_scopes (
  run_id uuid PRIMARY KEY REFERENCES outcome_offboarding_runs(run_id),
  environment_id uuid NOT NULL,
  project_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE TABLE nyst_sessions (
  session_hash char(64) PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES nyst_users(user_id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nyst_sessions_expiry_idx ON nyst_sessions(expires_at);

CREATE TABLE nyst_api_keys (
  api_key_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prefix text NOT NULL CHECK (prefix ~ '^nyst_[a-z0-9]{8,20}$'),
  secret_hash char(64) NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 16),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id),
  UNIQUE (organization_id, prefix)
);

CREATE TABLE nyst_reconciliation_jobs (
  action_id uuid PRIMARY KEY REFERENCES outcome_actions(action_id),
  due_at timestamptz NOT NULL,
  claim_token uuid,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE INDEX nyst_reconciliation_jobs_due_idx ON nyst_reconciliation_jobs(due_at)
  WHERE claim_token IS NULL;

CREATE TABLE nyst_continuation_leases (
  lease_hash char(64) PRIMARY KEY CHECK (lease_hash ~ '^[0-9a-f]{64}$'),
  action_id uuid NOT NULL REFERENCES outcome_actions(action_id),
  resolution_id uuid NOT NULL REFERENCES outcome_resolutions(resolution_id),
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  resolution_sequence integer NOT NULL CHECK (resolution_sequence >= 1),
  evidence_sequence integer NOT NULL CHECK (evidence_sequence >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION nyst_forbid_scope_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Nyst tenant scope rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_action_scopes_immutable
BEFORE UPDATE OR DELETE ON nyst_action_scopes
FOR EACH ROW EXECUTE FUNCTION nyst_forbid_scope_change();

CREATE TRIGGER nyst_offboarding_scopes_immutable
BEFORE UPDATE OR DELETE ON nyst_offboarding_scopes
FOR EACH ROW EXECUTE FUNCTION nyst_forbid_scope_change();
