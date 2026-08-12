-- Nyst v0.3.0 — Phase 1A. One durable authority boundary per environment.
--
-- The problem this solves.
--
-- Consequence admission and Emergency Freeze activation both decide whether a
-- consequential action may begin, but they took no lock in common. Admission
-- read committed freezes inside its own statement; freeze activation was a
-- bare INSERT that waited for nothing. Under READ COMMITTED that is *probably*
-- correct for most interleavings, because admission's second statement takes a
-- fresh snapshot — but "probably, because of snapshot timing" is not a safety
-- property. It cannot be demonstrated deterministically, and it leaves one
-- genuinely uncomfortable window: a freeze can commit and report durable
-- success to the operator while an admission whose snapshot predates it is
-- still in flight and about to commit.
--
-- An operator who has just been told "production is frozen" should not then
-- see a consequential action begin. So admission, freeze activation and freeze
-- release now all take a row lock on ONE row per environment before they do
-- anything else. That converts the ordering from an emergent property of
-- snapshot timing into a total order enforced by the database, and makes it
-- provable with barrier tests rather than with sleeps.
--
-- The cost is that consequential admissions in one environment serialize
-- against each other. That is deliberate. Correctness outranks throughput
-- here, and the critical section is two short statements.

CREATE TABLE nyst_environment_authority (
  environment_id      uuid PRIMARY KEY REFERENCES nyst_environments(environment_id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES nyst_projects(project_id),
  organization_id     uuid NOT NULL REFERENCES nyst_organizations(organization_id),

  -- Monotonic per environment. Every crossing of the authority boundary that
  -- CHANGES authority (freeze activate/release) increments it, so a test — and
  -- an operator reading the audit trail — can establish the true order of
  -- events without comparing timestamps, which is exactly what the previous
  -- design forced you to do.
  authority_sequence  bigint NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT nyst_environment_authority_scope
    FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);

COMMENT ON TABLE nyst_environment_authority IS
  'One row per environment. Locked FOR UPDATE by consequence admission, freeze activation and freeze release so those three operations have a single total order.';

-- Backfill every environment that already exists, so the guard is available
-- immediately rather than on first use.
INSERT INTO nyst_environment_authority (environment_id, project_id, organization_id)
SELECT environment_id, project_id, organization_id FROM nyst_environments
ON CONFLICT (environment_id) DO NOTHING;

-- New environments get their authority row automatically. Doing this in a
-- trigger rather than in application code means an environment created by a
-- migration, a fixture, or a future code path cannot end up without one.
CREATE OR REPLACE FUNCTION nyst_environment_authority_ensure() RETURNS trigger AS $$
BEGIN
  INSERT INTO nyst_environment_authority (environment_id, project_id, organization_id)
  VALUES (NEW.environment_id, NEW.project_id, NEW.organization_id)
  ON CONFLICT (environment_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_environment_authority_ensure_trigger
AFTER INSERT ON nyst_environments
FOR EACH ROW EXECUTE FUNCTION nyst_environment_authority_ensure();
