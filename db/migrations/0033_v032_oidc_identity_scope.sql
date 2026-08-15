-- Nyst v0.3.2 — Phase 12. AN OIDC SUBJECT IS ONLY MEANINGFUL WITHIN ITS ISSUER.
--
-- THE DEFECT.
--
-- 0025 keyed a live federated identity on:
--
--     UNIQUE (provider, provider_subject) WHERE disconnected_at IS NULL
--
-- For Google that is correct: there is exactly one Google, and a Google `sub`
-- is globally unique within it.
--
-- For generic OIDC it is wrong, and wrong in the direction that merges two
-- different people. `sub` is unique WITHIN AN ISSUER and carries no meaning
-- outside one. Okta hands out `00u...` identifiers; so does every other Okta
-- tenant. Keycloak, Auth0, Entra and a self-hosted provider each mint their own
-- namespace, and short numeric subjects like "123" or "1" are entirely ordinary
-- in test and self-hosted deployments.
--
-- So two customers on two different identity providers whose users happen to
-- share a subject value would have collided -- the second one either failing to
-- link, or resolving to the FIRST customer's Nyst account. That is a
-- cross-tenant authentication defect, and it is the kind that only appears once
-- a second enterprise customer exists.
--
-- THE KEY.
--
--     (provider, provider_config_id, provider_subject)
--
-- `provider_config_id` names the verified issuer configuration. Google keeps
-- NULL, coalesced to a fixed sentinel so all Google identities share one
-- namespace exactly as they should. Every generic OIDC identity is scoped to
-- the provider configuration it was verified against.

DROP INDEX IF EXISTS nyst_federated_identities_live_subject;

CREATE UNIQUE INDEX nyst_federated_identities_live_subject
  ON nyst_federated_identities (
    provider,
    coalesce(provider_config_id, '00000000-0000-0000-0000-000000000000'::uuid),
    provider_subject
  )
  WHERE disconnected_at IS NULL;

-- The history index gains the same scope, so "how many times has this identity
-- connected" cannot silently span two issuers either.
DROP INDEX IF EXISTS nyst_federated_identities_subject_history;

CREATE INDEX nyst_federated_identities_subject_history
  ON nyst_federated_identities (
    provider,
    coalesce(provider_config_id, '00000000-0000-0000-0000-000000000000'::uuid),
    provider_subject,
    linked_at
  );

-- A generic OIDC identity MUST name its issuer configuration. Without one there
-- is no namespace for its subject, and it would silently join the sentinel
-- namespace alongside Google.
ALTER TABLE nyst_federated_identities
  ADD CONSTRAINT nyst_federated_identities_oidc_needs_config
  CHECK (provider <> 'oidc' OR provider_config_id IS NOT NULL);

COMMENT ON COLUMN nyst_federated_identities.provider_config_id IS
  'The verified issuer configuration this subject belongs to. Required for generic OIDC, because a '
  'subject identifier is unique only WITHIN an issuer -- two identity providers can both mint "123". '
  'NULL for Google, which is a single global issuer.';
