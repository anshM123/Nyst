# Gate 7 Stripe verification

Status: PASS / FROZEN on 2026-08-08.

## Exact scope

Gate 7 adds exactly two production EffectSpecs:

- `stripe.refund/1.0.0`: one exact full refund of a succeeded, test-mode PaymentIntent and its latest Charge.
- `stripe.payment_capture/1.0.0`: one exact final full capture of a manual, test-mode card PaymentIntent in `requires_capture`.

Partial or multiple refunds, partial capture, multicapture, overcapture, Connect, live-mode objects, asynchronous methods, automatic capture, provisioning, billing UI, and webhook ingestion are unsupported. Unsupported or inconsistent topology fails closed before consequence where possible and never authorizes a financial retry.

The adapter pins Stripe API version `2026-02-25.clover` and the fixed `https://api.stripe.com` origin. It accepts only `sk_test_` or `rk_test_` credentials at request time. Durable records contain only `env:NYST_STRIPE_CREDENTIAL`; no raw key is persisted.

## Safety model

The exact action-derived Stripe idempotency key, operation, API version, account ID, PaymentIntent ID, Charge ID, amount, currency, and test-mode requirement are persisted in the immutable DispatchPlan before consequence. Stripe idempotency is defense in depth, not effect proof.

Every resolution depends on independent Account, PaymentIntent, Charge, and bounded Refund-list reads. A matching `nyst_action_id` metadata value can establish attribution and therefore `verified`; an exact preexisting goal is `satisfied_unattributed`. Pending provider state remains `pending`. Contradictory, partial, duplicate, live-mode, or unsupported topology is `unprovable`. Even authoritative goal absence does not authorize automatic financial retry in v1.

## Deterministic and PostgreSQL evidence

Focused Gate-7 verification passed 38 tests across 5 suites. It covers clean success, preexisting goals, response loss, definitely-not-sent and ambiguous transport outcomes, malformed success responses, crash/restart, 2/10/100 concurrency, semantic collision, current and post-consequence provider faults, stale decisions, malicious EffectSpecs, monetary-context conflicts, exact capture request shape, partial/duplicate topology, pending/failed states, live-mode rejection, seeded property sequences, and repeated response-loss stress.

PostgreSQL tests execute both financial effects under ten-way contention and prove the exact DispatchPlan is durable before the single consequence. Direct SQL attacks attempting to rewrite amount, PaymentIntent identity, operation, idempotency key, credential reference, EffectSpec version, or delete the action are rejected.

Initial clean-room database: `outcome_gate7_cleanroom_20260808`. Final post-fix clean-room database: `outcome_gate7_final_20260808`.

- Dependency install: passed; 17 packages, 0 vulnerabilities.
- Migrations from zero: `0001_init.sql` through `0005_offboarding_runs.sql`.
- Strict typecheck: passed.
- Build: passed.
- Final complete Gate 1–7 suite with PostgreSQL: **370 passed / 0 failed / 0 skipped** across **68 suites**.
- Secret scan: zero raw Stripe credential matches in PowerShell history or the clean-room database. Workspace matches are deliberately fake negative-test fixtures only.
- Live runner packaging: passed and fails at environment validation without credentials.

## Live provider proof

Final live run `fff0ef58-f9a7-4b36-a919-2c60731855e2` executed normal and response-loss canaries for both effects against test account `acct_1U2IefD3DgCKEZvH`. All four actions produced attributed `verified` resolutions, valid signatures, forbidden retry, and exactly one target provider write. The two deliberately lost successful responses recovered from the persisted PostgreSQL action without redispatch.

All four final PaymentIntents were independently confirmed `succeeded` and fully refunded. Earlier diagnostic attempts were also cleaned by canceling uncaptured authorizations or fully refunding succeeded payments. The run recorded zero unsafe retries, zero duplicate financial effects, and zero false certainty.

## Defects found and fixed

1. The initial capture request sent `final_capture=true`. Stripe restricts that explicit parameter to multicapture-enabled PaymentIntents, while full capture already defaults to final. The production request now omits the parameter and a regression test binds the exact form body.
2. The live runner initially required immediate capture read convergence. It now accepts Nyst's truthful `pending` result and performs at most 60 one-second read-only reconciliations; it never redispatches.
3. Earlier local hardening corrected a post-mutation crash-hook catch boundary, a live-runner class temporal-dead-zone packaging failure, a credential-reference false positive, duplicate/partial topology handling, evidence clock consistency, and financial context binding.

Gate 7 is PASS / FROZEN at `C:\Users\Aryan\OneDrive\Documents\Nyst.ai-phase7-frozen`. Gate 8 may now begin under the master continuation plan.
