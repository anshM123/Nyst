-- Nyst v0.2.2 — allow interventions for a consequence that never became an action.
--
-- Blast Radius and Emergency Freeze both HOLD a consequence BEFORE any durable
-- action exists — that is the entire point of an admission gate. The original
-- constraint required every intervention to hang off an action or a Shadow
-- record, which made those two interventions impossible to record.
--
-- The subject requirement is kept for every kind where a subject genuinely
-- exists, so this relaxes the rule precisely rather than removing it.
ALTER TABLE nyst_intervention_events DROP CONSTRAINT nyst_intervention_subject;
ALTER TABLE nyst_intervention_events ADD CONSTRAINT nyst_intervention_subject CHECK (
  action_id IS NOT NULL
  OR shadow_evaluation_id IS NOT NULL
  -- A held consequence has no action by construction: it was never admitted.
  OR kind IN ('blast_radius_hold','freeze_blocked')
);
