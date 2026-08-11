-- Post-Gate-8 release hardening: durable session context and product-scope dispatch floor.
BEGIN;

ALTER TABLE nyst_users
  ADD CONSTRAINT nyst_users_user_org_uq UNIQUE (user_id, organization_id);

ALTER TABLE nyst_sessions
  ADD COLUMN organization_id uuid,
  ADD COLUMN selected_project_id uuid,
  ADD COLUMN selected_environment_id uuid;

UPDATE nyst_sessions s
SET organization_id = u.organization_id,
    selected_project_id = p.project_id,
    selected_environment_id = e.environment_id
FROM nyst_users u
JOIN LATERAL (
  SELECT project_id FROM nyst_projects
  WHERE organization_id=u.organization_id ORDER BY created_at,project_id LIMIT 1
) p ON true
JOIN LATERAL (
  SELECT environment_id FROM nyst_environments
  WHERE project_id=p.project_id AND organization_id=u.organization_id
  ORDER BY created_at,environment_id LIMIT 1
) e ON true
WHERE s.user_id=u.user_id;

ALTER TABLE nyst_sessions
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN selected_project_id SET NOT NULL,
  ALTER COLUMN selected_environment_id SET NOT NULL,
  ADD CONSTRAINT nyst_sessions_user_org_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES nyst_users(user_id, organization_id),
  ADD CONSTRAINT nyst_sessions_project_org_fk
    FOREIGN KEY (selected_project_id, organization_id)
    REFERENCES nyst_projects(project_id, organization_id),
  ADD CONSTRAINT nyst_sessions_environment_scope_fk
    FOREIGN KEY (selected_environment_id, selected_project_id, organization_id)
    REFERENCES nyst_environments(environment_id, project_id, organization_id);

-- Product action keys are namespaced with their durable environment UUID.
-- PostgreSQL refuses to prepare one unless the immutable ownership row is
-- already present and agrees with that namespace. Core/non-product actions
-- remain unaffected.
CREATE OR REPLACE FUNCTION nyst_require_product_scope_before_prepare()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  namespace text;
BEGIN
  namespace := split_part(NEW.business_key, ':', 1);
  IF NEW.internal_state = 'prepared'
     AND OLD.internal_state = 'intent_recorded'
     AND namespace ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM nyst_environments WHERE environment_id=namespace::uuid)
     AND NOT EXISTS (
       SELECT 1 FROM nyst_action_scopes s
       WHERE s.action_id=NEW.action_id
         AND s.environment_id=namespace::uuid
     ) THEN
    RAISE EXCEPTION 'product action requires durable tenant/project/environment scope before preparation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nyst_action_scope_before_prepare
BEFORE UPDATE ON outcome_actions
FOR EACH ROW EXECUTE FUNCTION nyst_require_product_scope_before_prepare();

COMMIT;
