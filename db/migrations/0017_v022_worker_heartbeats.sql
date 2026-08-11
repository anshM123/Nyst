-- Nyst v0.2.2 — Phase 23: worker liveness.
--
-- A Nyst deployment whose API answers while its workers are dead is worse than
-- one that is plainly down: it accepts consequential actions and then never
-- resolves their ambiguity. Worker liveness is therefore a first-class health
-- signal, not a dashboard nicety.
CREATE TABLE nyst_worker_heartbeats (
  worker_kind text NOT NULL CHECK (worker_kind IN ('reconciliation','recovery','reobservation','webhook')),
  instance_id text NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 120),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_kind, instance_id)
);
