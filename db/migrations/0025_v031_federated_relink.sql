-- Nyst v0.3.1 — issue 3. A DISCONNECTED IDENTITY MUST BE RECONNECTABLE.
--
-- THE DEFECT.
--
-- Migration 0024 declared, in its own comment, that "re-linking after a
-- disconnect writes a new row; it never edits the old one". It could not.
-- The table carried
--
--     UNIQUE (provider, provider_subject)
--
-- with no predicate, so the disconnected row kept the subject reserved for
-- the lifetime of the database. Disconnecting Google — plausibly a mis-click
-- in Settings — permanently barred that Google account from ever being
-- connected to Nyst again, by anyone, with no message explaining why.
--
-- The stated intent and the enforced constraint disagreed. The constraint won.
--
-- WHAT THE CONSTRAINT SHOULD SAY.
--
-- The property worth enforcing is about LIVE bindings: at any moment, one
-- provider subject resolves to at most one Nyst user. Two users holding the
-- same live Google identity is a takeover. But a subject whose binding has
-- been disconnected resolves to nobody, and re-claiming it requires actually
-- authenticating as that Google account — which means whoever does it controls
-- the identity. Refusing them is not a safety property; it is a bug that only
-- ever locks out legitimate users.
--
-- So: partial unique index over live rows. `userByProviderSubject` already
-- filtered on `disconnected_at IS NULL`, so reads were always correct; only
-- the write constraint was wrong.
--
-- History is untouched. The append-only trigger still refuses DELETE and still
-- refuses to edit a binding's subject, user or link time, so the disconnected
-- row remains exactly as it was written.

ALTER TABLE nyst_federated_identities
  DROP CONSTRAINT nyst_federated_identities_provider_provider_subject_key;

-- At most one LIVE binding per provider subject. Concurrent re-links race on
-- this index and exactly one wins, the same way the old constraint behaved
-- for concurrent first-links.
CREATE UNIQUE INDEX nyst_federated_identities_live_subject
  ON nyst_federated_identities (provider, provider_subject)
  WHERE disconnected_at IS NULL;

-- Reconnection history stays queryable: "how many times has this Google
-- account been connected here, and by whom" is answerable without the unique
-- index having to carry it.
CREATE INDEX nyst_federated_identities_subject_history
  ON nyst_federated_identities (provider, provider_subject, linked_at);
