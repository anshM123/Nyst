-- Serialize material evidence arrival with guarded retry ownership.
BEGIN;

ALTER TABLE outcome_runtime
  ADD COLUMN IF NOT EXISTS evidence_sequence integer NOT NULL DEFAULT 0
  CHECK (evidence_sequence >= 0);

UPDATE outcome_runtime runtime
SET evidence_sequence = evidence.latest
FROM (
  SELECT action_id, COALESCE(MAX(seq), 0)::integer AS latest
  FROM outcome_evidence
  GROUP BY action_id
) evidence
WHERE runtime.action_id = evidence.action_id;

CREATE OR REPLACE FUNCTION outcome_bump_runtime_evidence_sequence() RETURNS trigger AS $$
BEGIN
  UPDATE outcome_runtime
  SET evidence_sequence = GREATEST(evidence_sequence, NEW.seq), updated_at = now()
  WHERE action_id = NEW.action_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outcome_evidence_bump_runtime_sequence ON outcome_evidence;
CREATE TRIGGER outcome_evidence_bump_runtime_sequence
  AFTER INSERT ON outcome_evidence
  FOR EACH ROW EXECUTE FUNCTION outcome_bump_runtime_evidence_sequence();

COMMIT;
