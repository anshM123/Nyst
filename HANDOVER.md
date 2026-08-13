# Nyst v0.3.0 — handover

**Read this first. Ten minutes.**

- To run it: **[RUN.md](RUN.md)**
- What was and was not verified: **[VERIFICATION.md](VERIFICATION.md)**
- Where Nyst stops: **[docs/product/known-boundaries.md](docs/product/known-boundaries.md)**

---

## What this release is

Nyst is the safety control plane between autonomous software and the systems it
changes. v0.3.0 adds the layer the product was missing.

Three questions, kept deliberately separate, because collapsing them is where
the failure lives:

| Layer | Question | Values |
| --- | --- | --- |
| **Authority** | What may this Agent do? | autonomous · human · disabled |
| **Effect** | What happened to this operation? | six EffectStates |
| **Outcome** | What became true in the world? | satisfied · unsatisfied · indeterminate |

## The one thing to understand

> An offboarding agent removes Alice's direct access to a production
> repository. GitHub accepts it. The response is lost, so Nyst refuses to retry
> blindly, reads back, and establishes that the direct grant is gone.
>
> **The action is VERIFIED.**
>
> Alice is in a team that grants WRITE to the same repository. Her effective
> access never changed. Every log in the stack says the offboarding succeeded.
>
> **ACTION VERIFIED. OUTCOME UNSATISFIED.**

Everything in the effect layer is correct. The outcome is false. That gap is
the entire reason this release exists, and the product says both sentences on
one screen, in words, without anyone having to click.

You can reproduce it in about thirty seconds — `/failure-lab`, run *"Direct
access removed, inherited access remains"*. The verdict is computed by the same
evaluator that runs in production, not a scripted demo.

---

## What is in the box

**The Outcome layer.** Immutable contracts, append-only WorldFacts, a
deterministic invariant engine with **no LLM anywhere in the safety path** —
nine operators, no `eval`, no expression language. Exactly three verdicts.
Signed Outcome Receipts.

**The Authority layer.** The Autonomy Line is an envelope, not a trust score:
GitHub revoke autonomous, GitHub grant human, AWS disabled. A single number
cannot say that, and the difference between revoke and grant is the whole
safety question. Human exceptions are attributed, reasoned and time-limited —
and they can never change what Nyst observed.

**Outcome Shadow.** Point Nyst at existing agents, change nothing, and it
reports the gap: *"Your Agent considered this workflow complete, and Nyst
observed that the required condition remained false for 14m 23s."* Measured
between two observations, never estimated. Nyst is not in the path in Shadow
and never says it prevented anything — the code enforces that wording.

**Evidence Ingest and the Relay.** Nyst cannot integrate with everything, so
customers can push observations from their own systems, or run a Relay inside
their network so credentials never leave. Customers push **evidence**; Nyst
evaluates **truth**. A push shaped like a conclusion is refused by name.

**Failure Lab 2.0 and NystBench.** Thirteen injectable faults; a deterministic
benchmark whose every figure is recomputable and labelled SIMULATED.

**The public site**, pricing, a deployment configurator, contact, and Google
Sign-In with a twenty-one-case security matrix.

---

## Numbers

| | |
| --- | --- |
| Tests | **851 passing, 0 failing, 0 skipped** (111 suites, ~45s) |
| Migrations | 24, applied cleanly from an empty database |
| Runtime dependencies | 4 |
| Secret scan | clean across source, tests, docs, migrations and assets |
| Clean-room verification | extract → `npm ci` → migrate empty DB → 851 tests → start → sign in → every page 200 |

## Defects found and fixed in this release

Twelve, every one reproduced before it was fixed. The three that would have
been most expensive in production:

1. **`pg` was a devDependency.** The production image shipped without the one
   package it cannot start without.
2. **The recovery worker discarded its ownership check** and called the
   provider anyway — a duplicate external effect, the one thing this product
   promises never happens.
3. **Readiness had two definitions**, so one screen could say Ready while
   another said Not Ready for the same provider at the same instant. There was
   even a test asserting the contradiction.

Full list in [VERIFICATION.md](VERIFICATION.md).

---

## What this is NOT

**Nyst v0.3.0 is not launch ready**, and no document in this package says
otherwise.

The architecture is complete, the tests pass with nothing skipped, and every
known defect has a regression test. But five things have not been done, and no
number of passing tests substitutes for them:

| Gate | Status |
| --- | --- |
| **Live provider mutation** | Never performed. No real GitHub, Okta or Stripe credential was used at any point, by instruction. **LIVE PROVIDER REVERIFICATION REQUIRED.** |
| **Google Sign-In** | Never run against a real Google project. 21 security cases pass against a generated key pair. **LIVE GOOGLE PROJECT CONFIGURATION REQUIRED.** |
| **Production Docker image** | Never built — Docker was unavailable on the build machine. The packaging defect is fixed and has a regression test; the image itself is unproven. |
| **Mutation through the Relay** | Deliberately not implemented. Reads only. A partial version would create exactly the duplicate-consequence risk Nyst exists to prevent. |
| **AWS / Google Workspace** | No first-party readers. Covered by customer-side evidence, and Nyst claims no coverage it does not have. |

Those five are the work between here and a launch decision.
