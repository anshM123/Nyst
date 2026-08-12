# Verification status — Nyst v0.2.2

What was actually checked for this release, how, and what was not.

The rule applied throughout: **if something could not be independently tested
in the build environment, it is not marked passing.** It is listed below as not
verified, with the reason.

---

## Summary

| | |
| --- | --- |
| Automated tests | **658 passing, 0 failing, 0 skipped** |
| Test suites | 96 |
| Migrations | 17, applied cleanly from an empty database |
| Dependency vulnerabilities | **0** (`npm audit`, with and without dev dependencies) |
| Runtime dependencies | 3 — `fastify`, `@fastify/cookie`, `bcryptjs` |
| Secret scan | No secret-shaped value in source, tests, docs, brand assets, the packed SDK tarball, or the Docker build context |

Test count over the course of this work: 444 at the v0.2.1 baseline → 658.

---

## Verified by execution

### Correctness

- Every named launch-blocking defect was **reproduced on the untouched v0.2.1
  baseline first**, then fixed, then covered by a regression test.
- Three further real bugs were found while fixing, each with a test that fails
  without the fix:
  - Metric windows silently excluded rows written in the same millisecond,
    because JavaScript truncates to milliseconds while PostgreSQL stores
    microseconds.
  - Shadow was missing the dispatch-boundary retry clamp that Enforced applies,
    so a Shadow finding could have been more permissive than reality.
  - The Blast Radius admission gate could admit two callers against a limit of
    one. A single statement holding `FOR UPDATE` still reads the snapshot taken
    before the lock was granted. Caught by a test that ran exactly two
    concurrent admissions; now verified with 2, 10 and 100.
- The same snapshot trap was later found in the rollout-mode endpoint, which
  reported the *previous* mode after a successful change.

### Concurrency and failure

- Emergency Freeze against **100 concurrent incoming actions**: nothing crosses
  the boundary.
- Blast Radius against **2, 10 and 100 concurrent callers**: the limit holds.
- Freeze/unfreeze cannot ABA into two overlapping authorities.
- A worker paused beyond its lease cannot complete after another worker
  reclaimed the work.
- A backwards application clock is harmless: lease ownership uses the database
  clock.
- The service recovers from having every database connection terminated
  underneath it, and serves correctly afterwards over new connections.

### Backup and restore — performed, not described

Executed against PostgreSQL 17.2 on 2026-08-11:

fresh database → 17 migrations from zero → seeded **only through real product
surfaces** → workers run until all four loops recorded heartbeats → `pg_dump`
→ restore into a **different, freshly created database** → verified.

Both fingerprints were **identical**, and the **receipt signature verified in a
different database, in a new process**. Nyst was then started against the
restored database: `/health` and `/ready` answered, login worked over HTTP,
every checked page rendered, and `/v1/actions/{id}/receipt` returned
`signature_valid: true`.

`scripts/verifyRestore.ts` reproduces this on demand.

### The published SDK

`@nyst-ai/sdk` 0.2.2 was packed and installed into a **clean project outside
this repository**, compiled against the shipped declarations with
`skipLibCheck: false`, and run against a live Nyst with a real API key. It read
actions, verified a signature, and rejected both a tampered body and a stale
delivery.

A drift test asserts the SDK's six effect states, four decision vocabularies,
and webhook signing are byte-identical to the server's.

**The package was NOT published to npm.**

### Security

Nineteen attacks against the HTTP surface: cross-organization IDOR on every
endpoint added in v0.2.2, cross-tenant writes, Agent-bound key impersonation,
API key scope, session/API-key separation, session revocation, CSRF on every
mutation, path and UUID validation, oversized bodies, stored-XSS rendering,
security headers on error responses, cookie flags, production HSTS,
error-body disclosure, and resolved-secret leakage.

Two real defects were found and fixed: an endpoint that answered for another
tenant's action, and 404 bodies carrying no request id.

### Adversarial pass

All 24 mandatory break-it scenarios are covered.
`tests/v022Phase32Security.postgres.integration.test.ts` documents where each
one is proven.

### Browser QA

Every surface driven at **1440×900 and 390×844** with the real stylesheet and
the real viewport: no page-level horizontal overflow, no table outside a scroll
container, no unlabelled input, no dead link, no disabled control without a
stated reason, no colour-only status, no positive tabindex, no touch target
under 32px, landmarks and a skip link on all fourteen surfaces, clean console.

Then every mutating control was **actually operated**. Three defects only this
could find:

- The Failure Lab form could never succeed — the endpoint required a parameter
  the engine ignored, and the form correctly did not send it.
- The rollout-mode endpoint reported the previous mode.
- Deliberate refusals reached the operator as `internal_error`, with the reason
  discarded.

A fourth was found by following this release's own [RUN.md](RUN.md) as written:
typing an organization's **display name** into the login form returned **500**,
because the slug validator threw a bare error. It is now an ordinary 401,
indistinguishable from a wrong password — so it also cannot be used to probe
which organization names are even well-formed.

### Clean room

Exported exactly what version control tracks, extracted to a fresh directory,
and verified from nothing: `npm ci` against the committed lockfile, all 17
migrations against an empty database, strict typecheck, production build, full
suite. One clean-room-only defect: `npm run typecheck` failed on a fresh clone,
invisible to anyone whose build output already existed.

### End-to-end acceptance

`scripts/acceptanceDemo.ts` walks the complete thesis over HTTP against a
database created from nothing, asserting each claim against what Nyst reports
back. **All 26 claims passed** — including that one action counts exactly once,
a replay does not inflate it, a freeze returns 409 to new consequence while
read-only reconciliation still returns 200, and release is refused without
explicit confirmation.

### Release archive

The shipped archive was extracted to a fresh directory, `npm ci`'d, migrated
against an empty database, and the full suite run **from the archive itself**:
658 passing.

---

## NOT verified

Stated plainly, because a verification document that lists only successes is
not a verification document.

### Docker image build — NOT INDEPENDENTLY VERIFIED

Docker is not installed in the build environment, so **the image has never been
built**. What was verified is the build *context* the daemon would receive: 192
files, no `.git`, no `node_modules`, no build output, no `.env`, no key
material, no database dump, no log, no archive — and everything the Dockerfile
copies present. The Dockerfile and compose file are unexercised.

### Live provider calls — NOT PERFORMED

No real GitHub, Okta or Stripe credential was used at any point, by design.
Provider semantics are exercised through deterministic provider-shaped clients,
synthetic adapters and fault injection.

No real adapter mutation semantics were changed in this release, so no live
reverification is owed — but equally, **no live provider call was made**.

### Scale — UNTESTED

Every measurement was taken on small datasets. There are no benchmarks, and
migration timing on a large table is unknown.

### Zero-downtime migration — NOT CLAIMED

No zero-downtime upgrade path has been proven, and none is claimed. There are
no `down` migrations and no automated rollback.
[docs/product/upgrades.md](docs/product/upgrades.md) states where a maintenance
window is required.

### Visual appearance — PROGRAMMATIC ONLY

Screenshots were unavailable in the build environment. UI verification was done
against the live DOM: computed styles, measured geometry, focusability, label
association, contrast tokens. That is stricter than eyeballing for overflow and
dead controls — but **no human has looked at the rendered pages**.

### Multi-region, HA, SSO, RBAC — NOT IMPLEMENTED

See [docs/product/known-boundaries.md](docs/product/known-boundaries.md).

---

## Cryptographic honesty

Receipts are signed with **Ed25519 software keys**. This is **tamper
evidence**: it proves a record has not been edited since signing, and anyone
with the public key can check that offline.

It is **not** hardware protection, **not** hardware attestation, and **not**
trusted timestamping. There is no HSM. Timestamps come from the local system
clock and are marked `trusted: false` in the receipt itself.

Production refuses to start with an ephemeral signing identity or a known
development key id, because a receipt signed by a key that no longer exists is
not proof of anything.

---

## What this release deliberately does not contain

- **No force-continue.** No API, SDK method, dashboard control or
  administrative escape hatch authorizes an action the safety floor forbids.
- **No seventh EffectState.** The set is closed at six.
- **No flattening** of EffectState and ControlDecision into one enum.
- **No probabilistic Canary.** Enforcement scope is always an explicit
  Agent × EffectSpec × Environment.
- **No fabricated numbers.** Enforced and Shadow are reported in separate
  columns and never summed; Shadow says "detected", never "prevented"; demo and
  Failure Lab activity never contributes to protection metrics.

Nyst is **not** described anywhere as guaranteed safe.
