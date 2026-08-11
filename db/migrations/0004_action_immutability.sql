-- Gate 4: logical intent and provider operation identity become immutable once
-- written. Lifecycle is the only ordinary mutable action field; DispatchPlan
-- may transition exactly once from NULL to a prepared plan.
CREATE OR REPLACE FUNCTION outcome_guard_action_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_id IS DISTINCT FROM OLD.action_id
     OR NEW.effect_name IS DISTINCT FROM OLD.effect_name
     OR NEW.business_key IS DISTINCT FROM OLD.business_key
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.input IS DISTINCT FROM OLD.input
     OR NEW.spec_version IS DISTINCT FROM OLD.spec_version
     OR NEW.value_minor_units IS DISTINCT FROM OLD.value_minor_units
     OR NEW.value_currency IS DISTINCT FROM OLD.value_currency
     OR NEW.risk_magnitude IS DISTINCT FROM OLD.risk_magnitude
     OR NEW.workload_id IS DISTINCT FROM OLD.workload_id
     OR NEW.workload_version IS DISTINCT FROM OLD.workload_version
     OR NEW.model_identity IS DISTINCT FROM OLD.model_identity
     OR NEW.model_config_hash IS DISTINCT FROM OLD.model_config_hash
     OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
     OR NEW.approval_required IS DISTINCT FROM OLD.approval_required
     OR NEW.approval_fired IS DISTINCT FROM OLD.approval_fired
     OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_clock IS DISTINCT FROM OLD.created_clock THEN
    RAISE EXCEPTION 'outcome action intent is immutable';
  END IF;

  IF NEW.internal_state IS DISTINCT FROM OLD.internal_state AND NOT (
    (OLD.internal_state = 'intent_recorded' AND NEW.internal_state IN ('prepared', 'abandoned_before_dispatch')) OR
    (OLD.internal_state = 'prepared' AND NEW.internal_state IN ('dispatching', 'abandoned_before_dispatch')) OR
    (OLD.internal_state = 'dispatching' AND NEW.internal_state = 'observing') OR
    (OLD.internal_state = 'observing' AND NEW.internal_state = 'reconciling') OR
    (OLD.internal_state = 'reconciling' AND NEW.internal_state IN ('observing', 'resolved'))
  ) THEN
    RAISE EXCEPTION 'illegal persisted action lifecycle transition: % -> %', OLD.internal_state, NEW.internal_state;
  END IF;

  IF OLD.dispatch_plan IS NOT NULL AND NEW.dispatch_plan IS DISTINCT FROM OLD.dispatch_plan THEN
    RAISE EXCEPTION 'outcome DispatchPlan is immutable once persisted';
  END IF;

  IF OLD.dispatch_plan IS NULL AND NEW.dispatch_plan IS NOT NULL AND NOT (
    OLD.internal_state = 'intent_recorded' AND NEW.internal_state = 'prepared'
  ) THEN
    RAISE EXCEPTION 'outcome DispatchPlan may only be created during preparation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outcome_actions_identity_immutable ON outcome_actions;
CREATE TRIGGER outcome_actions_identity_immutable
BEFORE UPDATE ON outcome_actions
FOR EACH ROW EXECUTE FUNCTION outcome_guard_action_identity();

CREATE OR REPLACE FUNCTION outcome_actions_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outcome actions are append-only identities';
END;
$$;

DROP TRIGGER IF EXISTS outcome_actions_no_delete ON outcome_actions;
CREATE TRIGGER outcome_actions_no_delete
BEFORE DELETE ON outcome_actions
FOR EACH ROW EXECUTE FUNCTION outcome_actions_no_delete();
