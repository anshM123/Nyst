-- Nyst v0.3.2 — Phase 8. PASSWORD RESET.
--
-- v0.3.1 had no recovery path at all. A local account whose owner forgot the
-- password was simply gone, which is not a state you can put a paying customer
-- in.
--
-- THE TOKEN IS NEVER STORED.
--
-- Only its SHA-256 is. A reset token is a bearer credential that grants
-- password change: anyone holding the row holds the account. Storing the digest
-- means a database read -- a backup, a log, a compromised replica, an operator
-- with SELECT -- yields nothing usable, exactly as `nyst_sessions` and
-- `nyst_api_keys` already work here.
--
-- SINGLE USE IS ENFORCED BY THE DATABASE, NOT BY THE HANDLER.
--
-- `consumed_at` plus a conditional UPDATE means two concurrent submissions of
-- the same link result in exactly one password change. A check-then-update in
-- application code leaves a window where both succeed, and the second one wins
-- silently.

CREATE TABLE nyst_password_resets (
  password_reset_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nyst_users(user_id) ON DELETE CASCADE,
  -- SHA-256 of the token. The token itself exists only in the email.
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Short. A reset link is a standing key to an account, and the window it is
  -- valid for is the window it can be stolen from a mailbox in.
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- Superseded by a newer request, or by a password change through another
  -- path. Distinct from consumed: nobody used this one.
  invalidated_at timestamptz,
  -- Operational context for abuse triage. Never identity.
  requested_ip inet,
  requested_user_agent text CHECK (requested_user_agent IS NULL OR length(requested_user_agent) <= 400),
  CHECK (expires_at > requested_at),
  -- A token cannot be both used and cancelled.
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

-- The only lookup that matters: a live token, by digest.
CREATE INDEX nyst_password_resets_live
  ON nyst_password_resets (token_hash)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- "How many resets has this user requested lately", for rate limiting and for
-- noticing that someone is being targeted.
CREATE INDEX nyst_password_resets_user
  ON nyst_password_resets (user_id, requested_at DESC);

-- ---------------------------------------------------------------------
-- CHANGING A PASSWORD MUST END EVERY SESSION.
--
-- The reason a person resets a password is usually that they think someone else
-- has it. Leaving that someone else holding a live session cookie defeats the
-- entire exercise -- they keep the account and the owner believes they have
-- recovered it.
--
-- Enforced by trigger rather than by remembering to call a function, because
-- there is now more than one path that changes a password and there will be
-- more later.
CREATE OR REPLACE FUNCTION nyst_password_change_revokes_sessions() RETURNS trigger AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    DELETE FROM nyst_sessions WHERE user_id = NEW.user_id;
    -- Any other outstanding reset link is now moot, including one an attacker
    -- may have requested in parallel.
    UPDATE nyst_password_resets
       SET invalidated_at = now()
     WHERE user_id = NEW.user_id AND consumed_at IS NULL AND invalidated_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_password_change_revokes_sessions
  AFTER UPDATE OF password_hash ON nyst_users
  FOR EACH ROW EXECUTE FUNCTION nyst_password_change_revokes_sessions();

COMMENT ON TABLE nyst_password_resets IS
  'Password reset tokens, stored as SHA-256 digests. Single use, time limited, '
  'user bound, and invalidated wholesale whenever the password changes by any path.';
