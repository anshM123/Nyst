-- Nyst v0.2.2 — Phase 15: the full set of SAFE human-review outcomes.
--
-- v0.2.1 allowed only acknowledge / re-observation / closed. Two more outcomes
-- are genuinely safe and were previously unrepresentable:
--
--   cancelled                  the workflow is abandoned where that is
--                              semantically valid. Cancelling removes future
--                              consequence; it never creates any.
--   compensation_authorized    a supported compensation was authorized through
--                              the SAME path automatic recovery uses, so the
--                              action-bound policy and runtime disposition are
--                              re-checked. A human cannot authorize a
--                              compensation Nyst would itself have refused.
--
-- Deliberately absent, and unrepresentable by design: any status meaning
-- "forced through", "assumed successful", or "state overridden".
ALTER TABLE nyst_human_reviews DROP CONSTRAINT nyst_human_reviews_status_check;
ALTER TABLE nyst_human_reviews ADD CONSTRAINT nyst_human_reviews_status_check
  CHECK (status IN ('open','acknowledged','reobservation_requested','compensation_authorized','cancelled','closed'));
