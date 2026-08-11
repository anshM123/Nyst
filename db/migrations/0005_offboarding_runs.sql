-- Gate 6: a narrow, immutable integrated offboarding-run identity. Provider
-- actions remain ordinary Nyst actions; this table stores only their links.
BEGIN;

CREATE TABLE IF NOT EXISTS outcome_offboarding_runs (
  run_id uuid PRIMARY KEY,
  business_key text NOT NULL UNIQUE CHECK (length(business_key) BETWEEN 1 AND 200),
  subject_key text NOT NULL UNIQUE CHECK (length(subject_key) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  intent jsonb NOT NULL,
  okta_action_id uuid REFERENCES outcome_actions(action_id),
  github_action_id uuid REFERENCES outcome_actions(action_id),
  created_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION outcome_guard_offboarding_run() RETURNS trigger AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.business_key IS DISTINCT FROM OLD.business_key
     OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.intent IS DISTINCT FROM OLD.intent
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'offboarding run intent is immutable';
  END IF;
  IF OLD.okta_action_id IS NOT NULL AND NEW.okta_action_id IS DISTINCT FROM OLD.okta_action_id THEN
    RAISE EXCEPTION 'offboarding Okta action reference is immutable';
  END IF;
  IF OLD.github_action_id IS NOT NULL AND NEW.github_action_id IS DISTINCT FROM OLD.github_action_id THEN
    RAISE EXCEPTION 'offboarding GitHub action reference is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_offboarding_runs_immutable
BEFORE UPDATE ON outcome_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION outcome_guard_offboarding_run();

CREATE TRIGGER outcome_offboarding_runs_no_delete
BEFORE DELETE ON outcome_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION outcome_forbid_change();

COMMIT;
