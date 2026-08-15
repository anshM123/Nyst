-- Nyst v0.3.3 — ADMIT THE `tenant:` SCHEME AT THE DATABASE BOUNDARY.
--
-- 0030 added a CHECK constraint that enumerates the legal reference schemes and
-- refuses anything SHAPED like a secret. Both halves are still wanted; only the
-- enumeration is stale, because v0.3.3 introduced a fourth scheme for
-- credentials the customer supplied through the UI.
--
-- WHY THIS IS A DATABASE CONSTRAINT AND NOT ONLY APPLICATION CODE.
--
-- The refusal exists because "store a REFERENCE, never the secret" is an
-- invariant of the data, not a rule of one code path. A future migration, an
-- admin script, a repair query run at 3am during an incident — none of those go
-- through the repository. This is the layer that is actually in front of every
-- writer, and it stays in front of them.
--
-- THE `tenant:` FORM IS CONSTRAINED HARDER THAN THE OTHERS.
--
-- `env:`, `vault:` and `secret-manager:` take a free-form path because their
-- shape belongs to somebody else's system. A tenant reference has exactly ONE
-- legal shape — the scheme followed by a UUID — so anything else is a bug and
-- is refused rather than stored and puzzled over later. That also means the
-- secret-shape rules below can never fire on a tenant reference: a lowercase
-- hyphenated UUID cannot look like a token.

ALTER TABLE nyst_integrations
  DROP CONSTRAINT IF EXISTS nyst_integrations_credential_ref_check;

ALTER TABLE nyst_integrations
  ADD CONSTRAINT nyst_integrations_credential_ref_check CHECK (
    length(credential_ref) BETWEEN 5 AND 300
    AND (
      credential_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
      -- Exactly a UUID. Nothing else is a tenant credential reference.
      OR credential_ref ~ '^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
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

-- The same enumeration appears on the preflight table, which records WHICH
-- reference each read-only probe was run against (0030 part C). Readiness
-- compares that to the reference configured now, so a tenant reference that
-- could be stored on one table and not the other would silently make every
-- customer-supplied credential permanently unverifiable.
ALTER TABLE nyst_integration_preflights
  DROP CONSTRAINT IF EXISTS nyst_integration_preflights_credential_ref_check;

ALTER TABLE nyst_integration_preflights
  ADD CONSTRAINT nyst_integration_preflights_credential_ref_check CHECK (
    credential_ref IS NULL
    OR (
      length(credential_ref) BETWEEN 5 AND 300
      AND (
        credential_ref ~ '^(env|vault|secret-manager):[A-Za-z0-9_./:-]+$'
        OR credential_ref ~ '^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      AND credential_ref !~ '(github_pat_|ghp_|gho_|ghs_|ghu_|sk_(test|live)_|rk_(test|live)_|xox[baprs]-|AKIA|GOCSPX-|AIza|Bearer[[:space:]])'
      AND credential_ref !~ 'ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
    )
  );
