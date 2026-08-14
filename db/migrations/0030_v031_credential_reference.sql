-- Nyst v0.3.1 — issue 11. A REFERENCE IS A NAME, AND A ROTATION IS NOT VERIFIED.
--
-- TWO DEFECTS FROM THE PROVIDER CONNECTION AUDIT.
--
-- A. THE SECRET-SHAPE REFUSAL WAS PREFIX-SPECIFIC, AND LIVED ONLY HERE.
--
-- 0006 guarded credential_ref with
--
--   credential_ref !~ '(github_pat_|ghp_|sk_(test|live)_|rk_(test|live)_|Bearer[[:space:]])'
--
-- Six prefixes. An Okta SSWS token, a 40-hex GitHub classic token, a Google
-- client secret, a Slack token or a JWT passed straight through and was stored
-- in cleartext -- and `sanitizeForProduct` exempts this column (correctly:
-- `env:NYST_GITHUB_TOKEN` is a NAME the UI must show), so a stored secret was
-- then echoed back by GET /v1/integrations and rendered into an HTML page.
--
-- Broadened below to a SHAPE rule rather than a longer vendor list, because the
-- next provider is not on any list. False positives are acceptable: refusing an
-- oddly-named variable costs a rename, accepting a token costs a disclosure.
--
-- B. ROTATING A CREDENTIAL DID NOT INVALIDATE ITS PREFLIGHT.
--
-- `configureIntegration` clears last_verified_at, but readiness reads
-- nyst_integration_preflights -- append-only, 12-hour TTL. Point the
-- integration at a different reference and readiness kept reporting
-- `preflight_verified: true` for up to twelve hours, on evidence gathered from
-- a credential that is no longer in use.
--
-- That is the exact untruth v0.2.2 existed to remove: a screen saying
-- "verified" about something nobody verified. The fix is to record WHEN the
-- current reference was configured, and to ignore any preflight older than
-- that.

/* -------------------------------------------------- A. reference shape */

ALTER TABLE nyst_integrations
  DROP CONSTRAINT IF EXISTS nyst_integrations_credential_ref_check;

ALTER TABLE nyst_integrations
  ADD CONSTRAINT nyst_integrations_credential_ref_check CHECK (
    length(credential_ref) BETWEEN 5 AND 300
    AND credential_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
    -- Known vendor prefixes. Unambiguous, so kept verbatim.
    AND credential_ref !~ '(github_pat_|ghp_|gho_|ghs_|ghu_|sk_(test|live)_|rk_(test|live)_|xox[baprs]-|AKIA|GOCSPX-|AIza|Bearer[[:space:]])'
    -- A JWT.
    AND credential_ref !~ 'ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
    -- 32+ hex characters. A GitHub classic token is 40 lowercase hex, so it has
    -- no uppercase and slips past the mixed-case rule below.
    AND regexp_replace(credential_ref, '^[a-z-]+:([A-Za-z0-9_.-]*[/:])?', '') !~ '^[0-9a-fA-F]{32,}$'
    -- SHAPE: 25+ characters mixing lower, upper and digits is a token, not a
    -- variable name. Applied to the part after the scheme and any path prefix,
    -- so `vault:kv/data/github/token` stays legal.
    AND NOT (
      length(regexp_replace(credential_ref, '^[a-z-]+:([A-Za-z0-9_.-]*[/:])?', '')) >= 25
      AND regexp_replace(credential_ref, '^[a-z-]+:([A-Za-z0-9_.-]*[/:])?', '') ~ '[a-z]'
      AND regexp_replace(credential_ref, '^[a-z-]+:([A-Za-z0-9_.-]*[/:])?', '') ~ '[A-Z]'
      AND regexp_replace(credential_ref, '^[a-z-]+:([A-Za-z0-9_.-]*[/:])?', '') ~ '[0-9]'
    )
  );

/* ------------------------------------------- B. rotation invalidation */

-- WHICH credential this preflight was run against.
--
-- The first attempt at this compared timestamps: `credential_configured_at` on
-- the integration against `performed_at` on the preflight. That is unsound, and
-- the existing readiness tests caught it immediately. `performed_at` comes from
-- the APPLICATION clock (`new Date()` in runPreflight) and
-- `credential_configured_at` from the DATABASE clock (`now()`), so a preflight
-- run milliseconds after a configure could compare as EARLIER than it, and a
-- freshly verified integration would report unverified.
--
-- Comparing timestamps was also answering the wrong question. "Was this
-- preflight run against the credential configured now?" is a question about
-- IDENTITY, not about time -- and identity is knowable exactly. Recording the
-- reference removes the clock from the comparison entirely, and correctly
-- treats rotating away and back to the same reference as still verified.
ALTER TABLE nyst_integration_preflights
  ADD COLUMN IF NOT EXISTS credential_ref text;

-- Backfill: the reference currently configured for that integration.
--
-- The append-only trigger refuses UPDATE, correctly, so it is disabled for this
-- one statement and restored immediately, inside the migration's transaction.
--
-- Permissive on purpose, and narrow in effect. `configureIntegration` has
-- always cleared `last_verified_at` on every save, so a rotation before this
-- migration already reset the other verification signal; and there are no
-- production deployments, so the rows this touches exist only in development
-- databases. Every preflight recorded from here on carries its real reference.
ALTER TABLE nyst_integration_preflights DISABLE TRIGGER USER;

UPDATE nyst_integration_preflights p
   SET credential_ref = i.credential_ref
  FROM nyst_integrations i
 WHERE p.credential_ref IS NULL
   AND i.environment_id = p.environment_id
   AND i.provider = p.provider;

ALTER TABLE nyst_integration_preflights ENABLE TRIGGER USER;

COMMENT ON COLUMN nyst_integration_preflights.credential_ref IS
  'The credential reference this preflight was run against. Readiness requires it to equal the '
  'integration''s current reference: a preflight proves the credential it tested, not whichever '
  'one happens to be configured later. Compared by identity rather than by time, because '
  'performed_at is an application clock and the integration row is stamped by the database clock.';
