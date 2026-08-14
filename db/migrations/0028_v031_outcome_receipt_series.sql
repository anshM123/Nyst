-- Nyst v0.3.1 — issue 8. A RECEIPT IS ABOUT AN INSTANT, NOT AN INSTANCE.
--
-- THE DEFECT.
--
--   outcome_instance_id uuid NOT NULL UNIQUE REFERENCES nyst_outcome_instances
--
-- One receipt per instance, permanently. issueReceipt inserted with
-- ON CONFLICT (outcome_instance_id) DO NOTHING and then returned whatever row
-- it found, so a second call did not fail, did not warn, and did not issue --
-- it returned the FIRST receipt, and the caller had no way to tell.
--
-- The flagship scenario in this system is a verdict that CHANGES. Alice's
-- direct grant is removed and the outcome is UNSATISFIED because a team still
-- grants her WRITE. A human authorizes the remediation, the inherited path goes,
-- Okta is suspended, and the outcome becomes SATISFIED.
--
-- If a receipt was issued at UNSATISFIED -- which is exactly when someone wants
-- one, because that is when there is a problem to escalate -- then the
-- SATISFIED receipt could never exist. Worse, asking for it returned the
-- UNSATISFIED one, correctly signed, with nothing marking it stale. A caller
-- asking "prove this outcome is now satisfied" got a valid signature over
-- "this outcome is not satisfied".
--
-- THE FIX. Key on (outcome_instance_id, evaluation_sequence). Each receipt
-- stays immutable forever; the SERIES grows. Asking twice at the same sequence
-- returns the same receipt, because nothing changed. Asking after a new
-- evaluation issues a new one, and every earlier statement stays readable --
-- what Nyst was willing to sign, and when.

ALTER TABLE nyst_outcome_receipts
  ADD COLUMN evaluation_sequence bigint;

-- Existing receipts predate the column. Each was issued from whatever the
-- instance's sequence was at the time, and the payload recorded it, so the
-- true value is recoverable rather than guessed. Anything unreadable falls
-- back to the instance's current sequence, which is where it was issued from.
--
-- The immutability trigger blocks this, correctly -- it refuses every UPDATE,
-- which is the whole point of a receipt. Backfilling a newly added column is
-- the one thing that legitimately needs to get past it, and a schema migration
-- is the only context in which that is true. Disabled for this statement alone
-- and restored immediately, inside the migration's transaction, so no
-- application code ever runs against an unprotected table.
--
-- Nothing signed changes: evaluation_sequence is derived FROM the signed
-- payload, so no payload, hash or signature is touched and every existing
-- receipt still verifies against exactly what it verified against before.
ALTER TABLE nyst_outcome_receipts DISABLE TRIGGER nyst_outcome_receipts_immutable_trigger;

UPDATE nyst_outcome_receipts r
   SET evaluation_sequence = coalesce(
     nullif(r.payload->>'evaluation_sequence', '')::bigint,
     (SELECT i.evaluation_sequence FROM nyst_outcome_instances i
       WHERE i.outcome_instance_id = r.outcome_instance_id),
     0)
 WHERE r.evaluation_sequence IS NULL;

ALTER TABLE nyst_outcome_receipts ENABLE TRIGGER nyst_outcome_receipts_immutable_trigger;

ALTER TABLE nyst_outcome_receipts
  ALTER COLUMN evaluation_sequence SET NOT NULL,
  ADD CONSTRAINT nyst_outcome_receipts_sequence_positive CHECK (evaluation_sequence >= 0);

-- The old constraint said "one receipt, ever". Replaced, not merely widened:
-- leaving it in place would silently keep the defect.
ALTER TABLE nyst_outcome_receipts
  DROP CONSTRAINT nyst_outcome_receipts_outcome_instance_id_key;

ALTER TABLE nyst_outcome_receipts
  ADD CONSTRAINT nyst_outcome_receipts_instance_sequence
  UNIQUE (outcome_instance_id, evaluation_sequence);

-- Reading the series newest-first is what both the UI and `receipt()` do.
CREATE INDEX nyst_outcome_receipts_series
  ON nyst_outcome_receipts (outcome_instance_id, evaluation_sequence DESC);

-- The immutability trigger from 0020 is unchanged and still applies: BEFORE
-- UPDATE OR DELETE raises unconditionally. Issuing a new receipt is an INSERT,
-- so the series grows without any existing statement being touched.
