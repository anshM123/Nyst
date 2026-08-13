# Known boundaries

What Nyst does not do, cannot do, or has not proven. Read this before you rely
on Nyst for anything that matters.

Nyst is **not** "guaranteed safe". It is a control plane that refuses to
overstate what it knows. That is a real and useful property, and it is a
different property from a guarantee.

---

## Coverage

**Four EffectSpecs.** `github.repository_permission_change`,
`okta.user_suspension`, `stripe.refund`, `stripe.payment_capture`. Anything
outside them is not controlled by Nyst, and Nyst has no opinion about it.

**Adding one is engineering, not configuration.** See
[EffectSpec semantics](effectspec-semantics.md). It requires a read-only
observation path, an attribution rule, eventual-consistency handling, and
deterministic coverage of every ambiguity mode the provider can produce.

**Stripe effects are sandbox-shaped.** Exact full refund and exact final full
capture only. Partial amounts are a different effect, not a variation of these.

---

## What determines the answer

**Nyst is only as good as the provider's observability.** Nyst determines
effect state by *looking*. If a provider offers no authoritative read for an
effect, the honest answer is `unprovable`, and you will get it — repeatedly.
That is not a bug to be tuned away.

**Attribution is often impossible.** GitHub will tell you a principal's current
permission. It will not tell you who set it. When the goal state is present but
causation cannot be established, Nyst returns `satisfied_unattributed`, which
allows continuation and forbids retry. This is the correct answer, and it will
be a large fraction of your real traffic.

**Reconciliation costs provider calls.** Ambiguity is resolved by observing,
and observing consumes rate limit. A large backlog of ambiguous actions
resolves at the speed the provider allows.

**Nyst cannot detect an effect applied outside it.** If someone changes a
permission by hand, Nyst sees the end state, not the act. That is exactly the
`satisfied_unattributed` case.

---

## Cryptography and proof

**Software signing only.** Ed25519 keys held in the process environment. No
HSM, no hardware attestation, no trusted timestamping. A receipt is
tamper-*evident*: it proves the record has not been edited since signing. It
does not prove the machine that signed it was uncompromised.

**Timestamps are untrusted, and say so.** `resolved_at` comes from the local
system clock and is marked `trusted: false` in the receipt. Nothing prevents a
compromised host from backdating it.

**Verification requires the public key.** Keep every retired public key
forever. Receipts signed by a key whose public half you discarded are
unverifiable, permanently. See [receipt signing](receipt-signing.md).

---

## Durability and scale

**Single-region PostgreSQL.** No multi-region consistency story. Nyst's
correctness properties rest on PostgreSQL transactions in one database.

**No proven zero-downtime migration path.** Migrations are proven from an empty
database. Rolling upgrades with mixed application versions against one schema
are untested, and there are no `down` migrations. See
[upgrades](upgrades.md), which states where a maintenance window is required.

**Untested at large scale.** Every measurement in this repository was taken on
small datasets. There are no published benchmarks, and migration timing on a
large table is unknown.

**Rate limiting is per-process and in-memory.** It resets on restart and is not
shared across instances. It is a courtesy, not a defence against a determined
attacker.

---

## Operations

**Workers must actually be running.** An API that answers while its workers are
dead is the most dangerous state a Nyst deployment can be in: it looks healthy,
accepts consequential actions, and never resolves them. Monitor
`/v1/operational-health` and alert on stale heartbeats. Nyst surfaces the
signal; it cannot page you.

**Webhooks are at-least-once.** Deduplicate on `action_id` plus
`resolution_version`. Delivery is DNS-pinned against rebinding, which also
means an endpoint whose address changes mid-delivery fails that attempt.

**Compensation is a directive, not a capability.** Nyst determines that a
compensation is required and records it. Executing one requires a recovery
executor you explicitly register. With none registered — the default — a
recovery that never crossed the dispatch boundary is **cancelled** rather than
executed. Deliberately fail-safe for a deployment that has not opted in.

**Preflight results expire after 12 hours.** A green integration tick from last
week is not evidence that a credential works today, so Nyst expires it rather
than letting it decay into a comforting lie. Re-run preflight after any
rotation.

---

## Product surface

**No force-continue, and no plan to add one.** There is no API, SDK method,
dashboard control, or administrative escape hatch that authorizes an action the
safety floor forbids. If you need one, Nyst is the wrong tool — not because
the feature is hard, but because it would remove the only guarantee Nyst
offers.

**Human review is bounded.** A reviewer is offered exactly the operations the
effective authority permits. They cannot authorize something the policy forbids.

**Slack notifications are links only.** No state changes from Slack. An
approval that can be granted by anyone who can post in a channel is not an
approval.

**Demo and Failure Lab are isolated by construction.** They run with a secret
provider that resolves nothing, so reaching a real credential from a simulation
is structurally impossible rather than merely disallowed. Their results are
labelled `SIMULATED` and never contribute to protection metrics.

**Metrics are separated, permanently.** Enforced protection and Shadow
detection live in different columns and are never summed. Nyst will not tell
you it prevented something it only watched.

---

## Verification status of this release

- 631 automated tests pass; 0 fail, 0 skipped.
- All 17 migrations apply cleanly from an empty database.
- Backup and restore verified into a *different* database, with the receipt
  signature re-verified in a new process.
- The published SDK verified from a clean external consumer project against a
  live Nyst.
- Browser QA performed at 1440×900 and 390×844 across all 14 surfaces.

Anything not listed above as verified should be treated as unverified.

---

## Things you might reasonably expect that are absent

| | Status |
| --- | --- |
| Multi-region / HA PostgreSQL guidance | Not provided |
| SSO / SAML / SCIM | Not implemented |
| Role-based access control beyond API key scopes | Not implemented |
| Billing or usage metering | Out of scope |
| Managed secret vault | Out of scope — see [secrets](secrets.md) for the extension point |
| A hosted Nyst service | Does not exist. Self-hosted only |
| Published npm package | Built and verified, **not published** |

---

## v0.3.0 boundaries

These are new in this release, and each one is a place where Nyst deliberately
stops rather than guessing.

**A read-only preflight cannot VERIFY a write capability.** Proving that a
credential can change a collaborator's permission would require changing one,
and invariant I20 forbids a preflight from mutating anything. So where a
provider publishes its own authorization metadata — GitHub token scopes, Okta
granted scopes — Nyst reads it and marks the capability AUTHORIZED. Where a
provider publishes nothing (Stripe restricted keys report no scope list), the
capability stays AVAILABLE and readiness says so by name. An operator may
record an explicit attestation; Nyst stores it as a **claim** with an author,
a timestamp and a mandatory justification, shows it as claimed-not-observed
everywhere it appears, and an actual observation always overrides it.

**Mutation through the customer Relay is NOT implemented.** Only reads. A
mutation Relay needs a durable dispatch boundary on the customer's side, a
two-phase protocol for the ambiguous window, and a read-back path Nyst can
drive independently when the Relay itself disappears mid-request. Shipping a
partial version would put a duplicate external consequence exactly where this
product promises there is none. See [the Relay protocol](relay.md).

**Google Sign-In has never run against a live Google project.** The
implementation is complete and exercised against deterministic key fixtures
covering twenty-one security cases — wrong audience, wrong issuer, expiry,
nonce, algorithm confusion, open redirect, email-match takeover, duplicate
subject and the rest. It has not been run against real Google credentials.
**LIVE GOOGLE PROJECT CONFIGURATION REQUIRED** before anyone signs in with it
in production.

**AWS evidence is a declared optional module, not a live adapter.** Selecting
it makes its invariant REQUIRED, which means an outcome stays INDETERMINATE
until AWS evidence actually arrives — through Evidence Ingest or a Relay. Nyst
ships no first-party AWS reader in this release, and an unselected module means
Nyst makes **no claim at all** about AWS access.

**Google Workspace has no first-party connector.** Customer-side evidence
through Evidence Ingest or the Relay covers it. Nyst does not claim coverage it
does not have.

**Enterprise OIDC is architected, not proven against a live IdP.** The generic
verifier is the same code path Google uses, and the provider configuration
table exists. No enterprise identity provider has been connected.

**Outcome coverage is only ever what is configured.** An outcome marked
SATISFIED means every *required and configured* invariant held on fresh
authoritative evidence. It does not mean nothing anywhere is wrong. Nyst
reports coverage as a fraction precisely so this is visible rather than
assumed.

**NystBench is a simulation.** Its numbers describe behaviour under thirteen
injected faults and nothing else. They are not a measurement of any customer's
production system and may not be published without the SIMULATED / ADVERSARIAL
BENCHMARK label.
