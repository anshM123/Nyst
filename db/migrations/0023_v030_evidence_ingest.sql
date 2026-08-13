-- Nyst v0.3.0 — Phases 8, 9, 10. EVIDENCE INGEST AND RELAY.
--
-- Nyst cannot build a first-party integration for every system a company runs,
-- and it should not pretend otherwise. So a customer can push structured
-- observations from their own internal systems, and can optionally run a Relay
-- inside their own network so provider credentials never leave it.
--
-- THE LINE THAT MATTERS.
--
-- A customer pushes EVIDENCE. Nyst evaluates TRUTH. There is no field here for
-- "this outcome is verified", no way to assert a verdict, and no path by which
-- a pushed record becomes a conclusion without going through the same
-- invariant engine as everything else. A customer who could push a verdict
-- would be able to make Nyst lie on their behalf, which defeats the product.

/* ====================================================== EVIDENCE SOURCES */

-- A registered system a customer may push observations from.
--
-- Registration is deliberate: an unregistered source is refused rather than
-- silently trusted, and the record carries whether Nyst treats it as
-- authoritative for the properties it reports.
CREATE TABLE nyst_evidence_sources (
  evidence_source_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  -- Stable identifier the customer uses in every push: "internal-vpn".
  source_key text NOT NULL CHECK (source_key ~ '^[a-z][a-z0-9_-]{2,60}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  -- How evidence from this source arrives.
  transport text NOT NULL CHECK (transport IN ('evidence_ingest','customer_relay')),
  -- Which properties this source may report. A source that pushes a property
  -- outside this list is refused: "our VPN system says the Okta account is
  -- suspended" is not evidence Nyst will accept from a VPN.
  permitted_properties text[] NOT NULL CHECK (array_length(permitted_properties, 1) BETWEEN 1 AND 50),
  -- Whether this source is AUTHORITATIVE for those properties, or merely
  -- corroborative. A required invariant cannot be satisfied by corroborative
  -- evidence alone, so this field decides real behaviour.
  authoritative boolean NOT NULL DEFAULT false,
  -- The customer's declared semantic version for their own adapter.
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 80),
  -- Opaque reference to the shared signing secret. NEVER the secret itself.
  signing_secret_ref text CHECK (
    signing_secret_ref IS NULL OR (
      length(signing_secret_ref) BETWEEN 8 AND 300
      AND signing_secret_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
      AND signing_secret_ref !~ '(github_pat_|ghp_|sk_(test|live)_|Bearer[[:space:]])')),
  -- How long a pushed observation stays fresh, unless the push says otherwise.
  default_freshness_seconds integer NOT NULL DEFAULT 900
    CHECK (default_freshness_seconds BETWEEN 60 AND 604800),
  created_by uuid NOT NULL REFERENCES nyst_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (environment_id, source_key),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_evidence_sources_scope
  ON nyst_evidence_sources (environment_id, source_key) WHERE revoked_at IS NULL;

/* ==================================================== INGESTED EVIDENCE */

-- Every pushed observation, exactly as received, forever.
--
-- Immutable and idempotent on (source, event_id). A customer retrying a push
-- after a network failure gets the original record back rather than creating a
-- second observation of the same event.
CREATE TABLE nyst_ingested_evidence (
  ingested_evidence_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  evidence_source_id uuid NOT NULL REFERENCES nyst_evidence_sources(evidence_source_id),
  -- The customer's own identifier for this observation event.
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 8 AND 200),
  subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 400),
  property text NOT NULL CHECK (property ~ '^[a-z][a-z0-9_.]{2,80}$'),
  value jsonb NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('string','integer','boolean','string_set','timestamp','absent')),
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  CHECK (fresh_until > observed_at),
  -- Bounded. A push is an observation, not a document store.
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 16384),
  -- Whether the request carried a valid signature. Recorded either way, so an
  -- unsigned push is usable and visibly weaker rather than silently equal.
  signature_verified boolean NOT NULL DEFAULT false,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The WorldFact this produced, so evidence and fact are linked both ways.
  world_fact_id uuid REFERENCES nyst_world_facts(fact_id),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_source_id, event_id),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_ingested_evidence_scope
  ON nyst_ingested_evidence (environment_id, subject_ref, property, observed_at DESC);

CREATE OR REPLACE FUNCTION nyst_ingested_evidence_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_ingested_evidence is append-only: an observation is a record of what a system reported, and when';
  END IF;
  IF NEW.ingested_evidence_id <> OLD.ingested_evidence_id OR NEW.event_id <> OLD.event_id
     OR NEW.subject_ref <> OLD.subject_ref OR NEW.property <> OLD.property
     OR NEW.value IS DISTINCT FROM OLD.value OR NEW.observed_at <> OLD.observed_at
     OR NEW.signature_verified <> OLD.signature_verified THEN
    RAISE EXCEPTION 'nyst_ingested_evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_ingested_evidence_immutable_trigger
  BEFORE UPDATE OR DELETE ON nyst_ingested_evidence
  FOR EACH ROW EXECUTE FUNCTION nyst_ingested_evidence_immutable();

/* ============================================================== RELAY */

-- A scoped, signed, replay-protected request Nyst asks a customer-side Relay
-- to perform inside the customer's own network.
--
-- Only READS in this release. `operation` is a closed set and every member of
-- it is an observation; there is no mutation operation, and adding one would
-- require a migration, a schema change and a code review rather than a config
-- flag. See docs/product/relay.md for why that boundary is where it is.
CREATE TABLE nyst_relay_requests (
  relay_request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  evidence_source_id uuid NOT NULL REFERENCES nyst_evidence_sources(evidence_source_id),
  -- Stable logical identity, so a retried delivery is the same request.
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 8 AND 200),
  operation text NOT NULL CHECK (operation IN (
    'observe_github_effective_permission',
    'observe_okta_account_status',
    'observe_aws_access_keys',
    'observe_generic_property')),
  subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 400),
  property text NOT NULL CHECK (property ~ '^[a-z][a-z0-9_.]{2,80}$'),
  -- The nonce the Relay must echo, and which Nyst will not accept twice.
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at),
  -- Short by design: a stale scoped request is an unnecessary capability
  -- sitting in someone's queue.
  CHECK (expires_at <= issued_at + interval '10 minutes'),
  signature text NOT NULL,
  key_id text NOT NULL,
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued','fulfilled','expired','rejected')),
  fulfilled_at timestamptz,
  ingested_evidence_id uuid REFERENCES nyst_ingested_evidence(ingested_evidence_id),
  rejection_reason text,
  UNIQUE (environment_id, operation_key),
  UNIQUE (environment_id, nonce),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

CREATE INDEX nyst_relay_requests_open
  ON nyst_relay_requests (environment_id, status, expires_at) WHERE status = 'issued';
