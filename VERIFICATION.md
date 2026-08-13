# Verification status — Nyst v0.3.0

What was actually checked for this release, how, and what was not.

The rule applied throughout: **if something could not be independently tested
in the build environment, it is not marked passing.** It is listed below as not
verified, with the reason.

---

## Summary

| | |
| --- | --- |
| Version | **0.3.0** |
| Automated tests | **851 passing, 0 failing, 0 skipped** |
| Test suites | 111 |
| Migrations | 24, applied cleanly from an empty database |
| Runtime dependencies | 4 — `fastify`, `@fastify/cookie`, `bcryptjs`, `pg` |
| Secret scan | No credential-shaped value in source, tests, docs, migrations, brand assets, the packed SDK tarball, or the Docker build context |

Test count across this work: 444 at the v0.2.1 baseline → 658 at v0.2.2 → **851**.

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

## Honest overall status

**Nyst v0.3.0 is not LAUNCH READY**, and this document will say so until it is.

What is true: the architecture is complete across all three layers, 851 tests
pass with nothing skipped, every known defect has a regression test, and every
boundary above is stated rather than hidden.

What is not: nothing in this release has been run against a real provider, a
real Google project, or a built production image. Those are the gates between
here and launch, and no amount of passing tests substitutes for them.
