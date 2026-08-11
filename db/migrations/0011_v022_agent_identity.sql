-- Nyst v0.2.2 — Agent identity.
--
-- Schema lands here (rather than later) because the Phase 1A canonical metric
-- contract requires a real `agent_breakdown` dimension. The product behaviour
-- built on top of it — registry management, agent-bound API keys failing
-- closed, cross-tenant denial — is Phase 6.
--
-- Purpose: EVERY CONSEQUENTIAL ACTION SHOULD ANSWER "WHO OR WHAT CAUSED THIS?"
--
-- This is deliberately a lightweight registry. It is not an agent builder, an
-- agent marketplace, or an orchestration layer.

CREATE TABLE nyst_agents (
  agent_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id),
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  framework text NOT NULL DEFAULT 'unspecified' CHECK (length(framework) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) <= 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES nyst_users(user_id),
  UNIQUE (environment_id, slug),
  -- The composite unique key lets every downstream binding prove, by foreign
  -- key alone, that an Agent belongs to the tenant scope using it.
  UNIQUE (agent_id, environment_id, project_id, organization_id),
  FOREIGN KEY (environment_id, project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id)
);
CREATE INDEX nyst_agents_environment ON nyst_agents(environment_id, status);

-- An Agent's tenant scope is its identity and can never move between tenants.
CREATE OR REPLACE FUNCTION nyst_guard_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id <> OLD.agent_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.environment_id <> OLD.environment_id
     OR NEW.slug <> OLD.slug
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'nyst: agent identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nyst_agents_identity_immutable BEFORE UPDATE ON nyst_agents
  FOR EACH ROW EXECUTE FUNCTION nyst_guard_agent_identity();

-- Historical actions stay bound to the Agent that caused them, permanently.
ALTER TABLE nyst_action_scopes ADD COLUMN agent_id uuid;
ALTER TABLE nyst_action_scopes ADD CONSTRAINT nyst_action_scopes_agent_fk
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
  REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id);
CREATE INDEX nyst_action_scopes_agent ON nyst_action_scopes(agent_id);

-- An API key may be bound to exactly one Agent. A bound key attempting to act
-- as a different Agent fails closed; enforcement lives in the repository and
-- is proven by the Phase 6 suite.
ALTER TABLE nyst_api_keys ADD COLUMN agent_id uuid;
ALTER TABLE nyst_api_keys ADD CONSTRAINT nyst_api_keys_agent_fk
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
  REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id);

ALTER TABLE nyst_shadow_evaluations ADD COLUMN agent_id uuid;
ALTER TABLE nyst_shadow_evaluations ADD CONSTRAINT nyst_shadow_agent_fk
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
  REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id);

ALTER TABLE nyst_intervention_events ADD COLUMN agent_id uuid;
ALTER TABLE nyst_intervention_events ADD CONSTRAINT nyst_intervention_agent_fk
  FOREIGN KEY (agent_id, environment_id, project_id, organization_id)
  REFERENCES nyst_agents(agent_id, environment_id, project_id, organization_id);
