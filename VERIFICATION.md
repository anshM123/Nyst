# Verification status — Nyst v0.3.2 (launch RC)

What was actually checked for this release, how, and what was not.

The rule applied throughout: **if something could not be independently tested
in the build environment, it is not marked passing.** It is listed below as not
verified, with the reason.

---

## Summary

| | |
| --- | --- |
| Version | **0.3.3 — launch RC** |
| Automated tests | **1155 passing, 0 failing, 0 skipped** |
| Test suites | 138 |
| Migrations | 37, applied cleanly from an empty database |
| Runtime dependencies | 4 — `fastify`, `@fastify/cookie`, `bcryptjs`, `pg` |
| Secret scan | No credential-shaped value in source, tests, docs, migrations, brand assets, the packed SDK tarball, or the Docker build context |

Test count across this work: 444 at the v0.2.1 baseline → 658 at v0.2.2 → 851 at v0.3.0 → 998 at v0.3.1 → 1125 at v0.3.2 → **1155**.

---

## What v0.3.3 added, and what proves it

**This is the first pass driven by a real deployed site.** Everything before it
was verified against a laptop database. Nyst now runs on Render against managed
PostgreSQL with Google sign-in working, and ten minutes of a person clicking
around found five defects that 1125 passing tests had no opinion about.

That is the finding, not an aside. **A test suite cannot fail on a control
nobody wired up**, and four of the five defects below are exactly that shape.

### The five

| Defect | Proof it is fixed |
|---|---|
| Failure Lab outcome buttons were forms with **no handler** — a native POST to a JSON+CSRF API, answered 403, rendered as raw JSON on a blank page | A **structural** test over all of `src/`: no `<form>` may post to a `/v1/` endpoint unless a handler is bound to its id or a data attribute. Plus a live browser click confirming the page does not navigate and renders a verdict |
| `PUT /v1/environment/mode` **never passed** the entitlements argument, so a trial organization could reach Enforced through the public API | A test that drives the **HTTP route** and asserts 402 + `blocked_by: entitlement` + a remedy, and that the mode did not move |
| Every credential reference had to be `env:` — an operator-only feature, so no self-serve customer could ever connect a provider | An HTTP connect flow storing a `tenant:` reference, plus the adversarial test below |
| A fresh deployment **bootstrapped into Enforced** | Verified on a genuinely empty database: an environment *named* "Production" comes up in `shadow` |
| Layout pinned to 1180px; Google sign-in was a blue text link | Measured in a real browser at 1920/1366/375. 99.2% of a 1920px viewport used, prose still capped at `--measure`, no horizontal scroll at any width |

### The credential scheme, and the risk it introduces

`tenant:<uuid>` names a ROW, which means unlike `env:` it is **addressable**.
If resolution were id-bound rather than scope-bound, one organization could
configure its integration with another organization's credential id — the
v0.3.2 Phase 2 defect through a new door.

So the scope is in the `WHERE` clause and bound into the cipher's AAD. Another
tenant's id is **not found** rather than found-and-refused: there is no
authorization step anybody can forget to write. There is a test that tries it.

Also verified: ciphertext never contains the plaintext, a revoked credential
stops resolving with no cache window, storing supersedes rather than
accumulating, a missing key **refuses to construct** rather than storing
plaintext, and the credential appears on **none** of 13 authenticated pages nor
in the server log — checked against a running server, not only in unit tests.

### Found by deploying it, after the first v0.3.3 commit

**Every deliberate 503 in the codebase was reaching operators as
`internal_error`.** The error handler read:

```ts
const status = candidate >= 400 && candidate < 500 ? candidate : 500;
if (status === 500) return reply.send({ error: "internal_error" });
```

503 is not inside 400–499, so it collapsed to 500 and its message was discarded
as if it were an unvetted stack trace — which is exactly the defect that
handler's own comment claims to have fixed, fixed only for 4xx.

It surfaced when an operator deployed without `NYST_CREDENTIAL_KEY`, pasted a
token, and was told `internal_error` for a configuration problem they could
have fixed in thirty seconds. The blast radius was every `statusCode: 503`
guard: "No SecretProvider is configured", the readiness and preflight guards,
the credential store.

Fixed with an explicit allowlist of statuses Nyst sets *deliberately*. **The
security property is unchanged and is now tested directly:** a message is
surfaced only when Nyst chose the status; a genuine unexpected throw still
returns nothing but a request id. There is a test that throws a message
containing a fake SQL string and asserts it never reaches the client.

Two related fixes: a 503 now answers `error: "not_configured"` rather than
`"invalid_request"` (nothing was wrong with the request), and the Integrations
page **no longer renders a paste-your-token box on a deployment that cannot
store one** — showing it meant a customer typed a real secret into a field
whose only possible outcome was a failure. Surfaced messages are now written to
survive the handler's 200-character truncation, with elaboration in `remedy`.

### Honest limitations of this release

- **The encryption key lives in the deployment's environment.** Someone with
  both the database and the running host has everything. This protects a leaked
  backup, a dropped disk and a SQL-injection read. It does not protect a
  compromised host. A KMS-backed key would; the constructor takes the key from
  outside precisely so that swap is a one-line change.
- **No live provider has been contacted.** Every credential in every test is
  provider-*shaped* and fake. The connect flow, the encryption and the refusal
  paths are verified; whether a real GitHub token produces a successful
  preflight is **NOT INDEPENDENTLY VERIFIED** and needs one read-only token.
- **Observation semantics remain `measured_at: null`** — DECLARED, NOT
  MEASURED — unchanged from v0.3.2, with the test that fails if one claims
  otherwise.
- **Screenshots were unavailable** in the verification environment. Layout was
  confirmed by measuring computed geometry and colours in a real browser
  (element widths, background colours, scroll overflow) rather than by eye.
- **Five tests failed transiently on one full-suite run** while two dev servers
  with active background workers were polling the same PostgreSQL instance.
  They pass in isolation and the suite is green across two subsequent clean
  runs. Recorded rather than omitted: it is a real property of running the
  suite alongside live workers.

---

## What v0.3.0 added, and what proves it

### The three layers

Authority, Effect and Outcome are separate, and a structural test fails the
build if a module blurs them: the outcome layer may not import the authority
evaluator, and the authority evaluator may not reach into the outcome
repository. They share types, never decisions.

### The Outcome layer

- **A deterministic invariant engine.** Nine operators, no `eval`, no
  expression language, **no LLM anywhere in the safety path**. Pure, therefore
  replayable: an auditor with the same contract version and the same facts gets
  the same verdict.
- **Exactly three verdicts**, never mixed with lifecycle. A test asserts
  `evaluating` and `pending` are not among them.
- **Four distinguishable kinds of not-knowing.** A missing fact, a stale fact,
  corroborative-only evidence, and two authoritative sources that disagree are
  all INDETERMINATE, and each says which it is. *Not seeing access is not the
  same as seeing no access.*
- **The flagship scenario passes end to end**: response lost, no blind retry,
  read-back establishes the direct grant is gone, and inherited team access
  still grants WRITE. **ACTION VERIFIED. OUTCOME UNSATISFIED.** Coverage 2/2,
  so the outcome is false because the world is wrong, not because Nyst is blind.

### The Authority layer

- **The Autonomy Line is an envelope, not a score.** A test asserts no numeric
  trust value appears anywhere in the module or on its page. GitHub revoke may
  be autonomous while GitHub grant needs a person — a scalar cannot say that.
- **An Agent with no rule has NO autonomy**, not unlimited autonomy.
- **Exceptions cannot rescue a Freeze, a Blast Radius refusal, or the
  EffectSpec safety floor.** An exception for $1,000 does not authorize $1,001.
  Half an authorization is not an authorization.
- **An exception never changes what Nyst observed.** A test drives a break-glass
  authorization against an unsatisfied outcome and asserts the verdict, the
  re-evaluation and the signed receipt all still say UNSATISFIED.
- **ContinuationGrants die when the world is re-observed.** Signed, narrow,
  single-use, expiring within the hour, pinned to a contract version and an
  evaluation sequence.

### Integration and evidence

- **Evidence Ingest**: a customer pushes evidence; Nyst evaluates truth. A push
  carrying `verdict`, `outcome`, `verified` or a conclusion-shaped property is
  refused **by name** with an explanation. A source may only report the
  properties it registered for, and authority comes from the registration
  rather than from the push.
- **The Relay**: signed, scoped, single-use read requests, nonce consumed
  atomically, ten-minute maximum lifetime, refusals that distinguish replay
  from expiry from unknown.
- **The Phase 17 degradation gate**, tests A–J, all passing: zero providers,
  read-only, read+write, cross-system, AWS unselected, AWS required-and-absent,
  integration revoked mid-outcome, insufficient permission, and customer
  evidence.

### Public surface

- **Motion cannot trap a visitor.** Tested by name for wheel handlers, scroll
  listeners, `preventDefault`, `scrollTo`, rAF loops, timers, history
  manipulation, `pointer-events: none`, full-screen overlays and mandatory
  scroll snap. Every scene renders in its final state from the server; the
  hidden state is applied by script, so JavaScript-off is fully readable. All
  motion is inside `prefers-reduced-motion: no-preference`. The logo does not
  spin — a test counts rotations and requires zero.
- **Contact is never gated.** No session, no signup, no JavaScript, a real form
  with a real action, a `mailto:` alternative, linked from every page.
- **Commercial entitlement may only ever refuse.** The module imports nothing,
  and a test asserts the authority evaluator never mentions commercial state.

---

## NOT INDEPENDENTLY VERIFIED

Each of these is implemented and tested against deterministic fixtures. None
has been run against the real thing, and none is marked passing.

| Area | Status | Why |
| --- | --- | --- |
| **Google Sign-In** | **LIVE GOOGLE PROJECT CONFIGURATION REQUIRED** | No Google project credentials exist in this environment. Twenty-one security cases pass against a locally generated key pair — wrong audience, wrong issuer, expiry, nonce, `alg=none`, HS256 confusion, unknown key, unverified email, open redirect, email-match takeover, duplicate subject, lockout, constant-time comparison, malformed input. The flow has never seen a real Google token. |
| **Enterprise OIDC** | Architected, not proven | Same verifier code path as Google, and the provider configuration table exists. No enterprise IdP has been connected. |
| **Live provider mutation** | **LIVE PROVIDER REVERIFICATION REQUIRED** | No real GitHub, Okta or Stripe credentials were used at any point in this build, by instruction. Provider semantics are exercised through deterministic provider-shaped clients and fault injection. |
| **AWS evidence** | Declared module, no live adapter | Selecting it makes its invariant REQUIRED, so an outcome stays INDETERMINATE until AWS evidence arrives through Evidence Ingest or a Relay. Nyst ships no first-party AWS reader. |
| **Google Workspace** | No first-party connector | Covered by customer-side evidence. Nyst claims no coverage it does not have. |
| **Mutation through the Relay** | **NOT IMPLEMENTED** | Reads only. A mutation Relay needs a durable dispatch boundary on the customer side and a two-phase protocol for the ambiguous window; a partial version would create the exact duplicate-consequence risk this product exists to prevent. |
| **Production Docker image** | Build not executed here | The packaging defect from v0.2.2 (`pg` under devDependencies) is fixed and has a regression test that walks every import reachable from a production entry point and asserts the production dependency closure can satisfy it. The image itself was not built in this environment. |
| **Real browser rendering** | Not executed | Page structure, escaping, accessibility attributes and the absence of inline script/style are asserted from rendered HTML. No browser was driven. |
| **NystBench figures** | **SIMULATED / ADVERSARIAL BENCHMARK** | Measured over thirteen injected faults, deterministic and recomputable from `per_fault`. Not a measurement of any production system, and unpublishable without that label. |

---

## Defects found and fixed in this release

Every one was reproduced before it was fixed.

1. **`pg` was a devDependency.** The production image shipped without the one
   package it cannot start without. Reproduced: production-only install gave
   `ERR_MODULE_NOT_FOUND`.
2. **The recovery worker discarded its ownership check** and called the
   provider anyway. A worker whose lease had expired still reached the
   provider — a duplicate external effect, invariant S1.
3. **Freeze and admission shared no lock**, so their ordering was an accident
   of snapshot timing.
4. **Readiness had two definitions.** One resolved the secret and required a
   preflight; the other compared a credential *reference string* to a constant.
   Same provider, same instant, two answers — with a test asserting the
   contradiction.
5. **Freezing one Agent displayed every unrelated workload as Frozen**, while
   admission would have admitted them.
6. **Policy readiness asked whether any policy row existed**, which is true in
   an environment whose only policy governs a different EffectSpec.
7. **Admission ran before input validation**, so malformed requests consumed an
   Agent's entire blast-radius budget.
8. **`amount_minor` was scraped from arbitrary caller JSON.** A GitHub
   permission change could declare itself a one-cent consequence.
9. **The aggregate budget used `coalesce(amount, 0)`**, so an amount-free action
   passed every aggregate monetary budget ever configured.
10. **The Slack button said "Request re-observation"** and linked to a query
    parameter nothing read.

Plus two test-harness defects fixed rather than tolerated: `node --test` ran
25 PostgreSQL files at CPU concurrency against `max_connections=100`, starving
the pool until one test took **549 seconds** and correct behaviour started
failing assertions.

---

## v0.3.2 — the launch-readiness pass

Eight defects, each **reproduced by a failing test before it was fixed**.

| # | Defect | Fix | Migration |
|---|---|---|---|
| 1 | `evaluateAuthority()` had ZERO production call sites | `authorizeConsequence` between admission and dispatch; layer constructed by `buildProductServer` so it cannot be omitted | — |
| 2 | Provider credentials process-global | `scopedCredentialSource` resolves the tenant's own reference; the constant became a default | — |
| 3 | A grant accepted any UUID as its exception | Every dimension validated; revocation de-authorises an issued grant | — |
| 4 | Signup spanned three unlinked statements | One transaction; refuses without a pool rather than degrading | — |
| 5 | New Google identity dead-ended at a 404 | Server-side single-use handoff to a workspace-name form | 0034 |
| 9 | Leads were durable but silent; quotes kept no price | Persist-then-notify; exact price string + catalog version | 0035 |
| 10 | Entitlement had no persistence and no caller | Persisted and enforced at the mode transition | 0032 |
| 11 | No integration disconnect | Built, and honest about what it does not stop | 0032 |
| 12 | OIDC identity keyed without its issuer | `(provider, provider_config_id, subject)` | 0033 |

**THE PATTERN WORTH NAMING.** Three of these — Authority, entitlement, and the
Google verifier in v0.3.1 — were a complete, well-tested model that nothing in
the request path called. A green test suite actively hides this: the unit tests
exercise the model, the HTTP tests never reach it, and a structural test
asserting "there is no second evaluator" is true and says nothing about whether
the one evaluator is used. **Every new safety mechanism now has a test that
drives it through the real route and counts real provider invocations.**

### Two judgement calls, stated rather than buried

**Bootstrap creates a default Autonomy Line rule** (`autonomous`, restricted to
`requires_reversible`). Without it, closing the Authority hole means a new
workspace can dispatch nothing and its first action fails with no explanation.
Irreversible effects still fall through to a human. A stricter product would
default to `human`; this chose usable-by-default for reversible effects.

**Disconnect is not a kill switch**, and the API response says so in its own
payload. It stops new work; Emergency Freeze stops work already admitted.

### Observation semantics replace guessed delays

`src/product/observationSemantics.ts` declares, per EffectSpec, how the world is
authoritatively observed, how long a read is trusted, how long convergence may
plausibly take, and when Nyst stops asking. A contradictory read inside the
window is `pending`; past it, repeated contradiction is `not_applied`; past the
deadline it is `unprovable`.

**Every window is `measured_at: null` — DECLARED, NOT MEASURED.** A test fails
the moment one claims otherwise, so a guess cannot quietly acquire the status of
a fact. A provider 429 is never evidence about the world.

---

## v0.3.1 — the backend hardening pass

Nine defects, each **reproduced by a failing test before it was fixed**. The
reproductions are kept, so a regression fails loudly rather than quietly.

| # | Defect | Fix | Migration |
|---|---|---|---|
| 1 | Public WorldFact forgery via `POST /v1/world-facts` | Route closed with a 405 that explains the Evidence/Truth boundary | — |
| 2 / 10 | `/signup` absent, then landing accounts in Enforced | Route built; `mode` is explicit, never the schema default | — |
| 3 | Google Sign-In unreachable; disconnected identity unrelinkable | Real routes wired end to end; partial unique index over live bindings | 0025 |
| 4 / 5 | Contact and quote submissions silently discarded | Durable tables; the page cannot claim delivery without a stored row | 0026 |
| 6 | Concurrent Outcome evaluation collided on `evaluation_sequence` | `FOR UPDATE` on the instance, taken before the facts are read | — |
| 7 | Out-of-order and concurrent WorldFact supersession | Partial unique index + BEFORE INSERT trigger on observation order | 0027 |
| 8 | One Outcome Receipt per instance, forever | Keyed `(instance, evaluation_sequence)`; the series grows | 0028 |
| 9 | Subject identity as permanent idempotency key | `request_key` separated from `subject_key`; live-only uniqueness | 0029 |
| 12 | `/ready` answered "ready" for any reachable socket | Asserts the required migration and signing capability | — |

Three defects were found **by the tests written for other defects**:

- Contract-version allocation had the same unlocked read-then-write race as
  issue 6, and ten concurrent creations failed nine times.
- A `FOR UPDATE` fix for issue 7 was *wrong in a way that passes a two-way test*
  — under READ COMMITTED the waiter re-reads after the winner commits, finds no
  incumbent, and inserts as current too. It fails at twenty. Replaced with an
  advisory lock on the key.
- An adversarial test in the issue 6 suite used a `source_type` the schema
  rejects, behind a blanket `.catch`, so its writes silently failed and it
  passed while proving nothing.

Migration 0027 **failed to apply on the development database**, because the
defect it fixes had already produced duplicate current facts there. Every
migration in this pass now repairs before it constrains.

---

## NOT INDEPENDENTLY VERIFIED

Stated plainly, because a passing test suite is not evidence for any of these.

### DOCKER IMAGE NOT BUILT

`docker build` was never run. Docker is not installed in the build environment
(`docker: command not found`; no Docker service registered), so **no claim is
made that the production image builds or runs.**

What *was* verified, without a daemon:

- Every path the Dockerfile `COPY`s exists; every artifact it takes from the
  build stage is one `npm run build` actually produces; every `npm run` script
  it invokes is defined.
- All three documented roles were executed locally with **the exact commands
  the image uses**:
  - `node --experimental-strip-types scripts/migrate.ts` — 29 migrations applied
    cleanly to an empty database.
  - `node --experimental-strip-types scripts/startProduct.ts` — served
    `/health` 200, `/ready` 200, `/`, `/login`, `/signup`, `/contact` all 200.
  - `node --experimental-strip-types scripts/startWorker.ts` — started and ran.
- `CMD` is exec form, the final `USER` is not root, no credential-shaped value
  is baked into any `ENV`, and `HEALTHCHECK` probes `/health` rather than
  `/ready`.

A test asserts Docker is *absent*, so if it ever becomes available that test
fails and tells whoever sees it to run the real build.

### LIVE GOOGLE PROJECT CONFIGURATION REQUIRED

Google Sign-In is implemented and driven end to end through the real routes
against a fixture Google — a locally generated RSA key pair standing in for
Google's signing keys, and a transport standing in for its token and JWKS
endpoints. **No real Google credential has ever been used, and the flow has not
run against a live Google project.**

For the failure cases the fixture is *better* than a live project, because each
one can be produced exactly: wrong nonce, wrong issuer, wrong audience, expired,
unknown key, forged signature, `alg: none`, unverified email, replayed callback.
All seven refusals are asserted **byte-identical**.

What a live project would additionally establish: that the real client ID and
redirect URI are registered correctly, that Google's actual JWKS parses, and
that consent behaves as expected.

### NO PROVIDER MUTATION HAS BEEN PERFORMED

No real GitHub, Okta or Stripe credential exists in this environment and none
was requested. Provider behaviour is exercised through deterministic
provider-shaped clients and fault injection.

---

## Honest overall status

**Nyst v0.3.2 is not LAUNCH READY**, and this document will say so until it is.

What is true: the architecture is complete across all three layers, 1155 tests
pass with nothing skipped, every known defect has a regression test that failed
first, and every boundary above is stated rather than hidden.

What is not: nothing in this release has been run against a real provider, a
real Google project, or a built production image. Those are the gates between
here and launch, and no amount of passing tests substitutes for them.
