-- Nyst v0.3.2 — Phase 5. GOOGLE SIGNUP.
--
-- A Google identity Nyst had never seen got a 404 saying "Nyst does not create
-- an account automatically from a Google sign-in". Accurate, and a dead end:
-- someone who clicked Continue with Google on the SIGNUP page was told to go
-- and sign up.
--
-- The original refusal had a real reason behind it. A workspace needs a NAME
-- and a short public identifier, and neither can be inferred from a Google
-- profile without producing something like `john-gmail` as an organization
-- slug. So the flow asks for exactly that and nothing else.
--
-- THIS TABLE IS THE HANDOFF between "Google verified this person" and "they
-- typed a workspace name". The verified identity must survive a form
-- submission WITHOUT travelling through the browser -- if a browser could POST
-- an arbitrary provider_subject, anyone could claim any Google account without
-- ever talking to Google.
--
-- So the identity is stored here and the browser carries only an opaque random
-- handle, of which only the SHA-256 is stored. Same rule as sessions, API keys
-- and password resets: a database read yields nothing usable.

CREATE TABLE nyst_google_signups (
  google_signup_id uuid PRIMARY KEY,
  -- SHA-256 of the handle. The handle itself exists only in the redirect.
  handle_hash char(64) NOT NULL UNIQUE CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  -- The VERIFIED Google subject. Written only after token verification.
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_verified boolean NOT NULL,
  -- An optional OIDC profile claim, used only to prefill a field the person
  -- can change. Nothing depends on it.
  display_name text CHECK (display_name IS NULL OR length(display_name) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Short. A stale signup should start again, not resume.
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX nyst_google_signups_live
  ON nyst_google_signups (handle_hash)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE nyst_google_signups IS
  'Carries a VERIFIED Google identity across the workspace-name form. Single use, short lived, and '
  'stored server-side so nothing about the identity travels through the browser where it could be forged.';
