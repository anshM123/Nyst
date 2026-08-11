# Phase 1 — launch-blocking correctness (internal completion note)

Baseline `92a1cf0` → Phase 1 checkpoint. Suite: **483 pass / 0 fail / 0 skip**, stable
across repeated full runs with PostgreSQL 17.2.

## Defects reproduced on the untouched baseline first

Recorded before any fix, against the unmodified v0.2.1 tree:

```
1A backend unsafe_retries_prevented_enforced = 1; overview card renders = 0
1B runtime continuation = allowed; policy.auto_continuation = false -> lease ISSUED
1C jobs after sync = 1; after escalation = 0; after second sync = 1   (resurrected)
1D reclaim after lease expiry = NULL   (row stuck in `executing` forever)
1G reclaim of expired read-only re-observation = NULL
1H shadow record stores spec_version column: false
```

## What changed

**1A — one canonical metric contract.** `src/product/canonicalMetrics.ts` defines
`CanonicalMetrics` with no `any` and no `?? 0` masking; `requireMetricInt` throws
`MetricContractError` when a required metric is absent or null, while accepting an
explicit 0. `overview()` and `impactMetrics()` are now thin aliases of
`canonicalMetrics()`, and `overviewPage()` is typed against `CanonicalMetrics`, so a
field-name drift is a compile error rather than a silent zero. Demo environments return
a zeroed contract.

*Bug found while fixing this:* binding the range upper bound from a JS `new Date()`
excluded rows written in the same millisecond, because the application clock truncates
to milliseconds and PostgreSQL stores microseconds. Every non-custom range is now
open-ended (`sql_upper_bound: null`) and the database decides what "now" means. This
was a genuine intermittent under-count, not just test flake.

**1B — one effective-authority operation.** `src/product/effectiveAuthority.ts` is the
single intersection `runtime ∩ action-bound policy`, never a union. Every branch
narrows; none widens. It is enforced twice — in the application and by the
`SQL_AUTOMATIC_CONTINUATION_AUTHORITY` / `SQL_AUTOMATIC_COMPENSATION_AUTHORITY`
predicates embedded in the lease-issuance, lease-consumption, recovery-authorization and
recovery-claim statements — so a second process or a future code path cannot route
around it. The policy consulted is always the immutable action-bound version. The
previously ceremonial `constrainDecision()` now delegates here instead of being a second
implementation used only by tests. There is no Force Continue.

**1C — durable suppression.** `nyst_reconciliation_suppressions` (immutable on UPDATE).
`scheduler.sync()` both refuses to insert suppressed actions and sweeps away any job that
contradicts a suppression, so neither repeated syncs, a fresh scheduler process, nor a
direct row insert can resurrect automatic reconciliation. External EffectState is
untouched (I14) and `outcome_runtime.next_check_at` is preserved as historical evidence.
Human Review can still request exactly one new read-only re-observation.

**1D/1E/1F — recovery dispatch boundary.** `nyst_recovery_executions` gains
`dispatch_state` ∈ {definitely_not_sent, attempted, may_have_been_sent, ambiguous,
completed}, `attempt`, a stable `recovery_operation_id`, and states
{authorized, executing, observing, completed, needs_review, cancelled}. Append-only
`nyst_recovery_dispatch_attempts` records where each attempt stopped, written *before*
the send. Reclaim is decided by the boundary, not the lease:

| dispatch_state | reclaim behaviour |
|---|---|
| `definitely_not_sent` + authority valid | may resume the send |
| `definitely_not_sent` + authority stale | cancel; no consequence was issued |
| `attempted` / `may_have_been_sent` / `ambiguous` | observe read-only; **never** resend |
| `completed` | no-op |

A DB check constraint makes `completed` require `dispatch_state='completed'` and
`cancelled` require `definitely_not_sent`, and the boundary can only advance. Completion
pins the current claim token *plus* expected action, recovery operation, policy version,
resolution sequence and evidence sequence, which closes the ABA race. `failed` is gone:
every path reaches completed, a safe reclaim, needs_review, or cancelled.

**1G — re-observation reclaim.** Read-only work is always safe to reclaim, so an expired
`executing` claim is reclaimable, attempts are counted and bounded (exhausted jobs go to
`needs_review` rather than vanishing), and completion requires the current token.

**1H/1I — Shadow.** `recordShadowEvaluation` now requires the caller to name the exact
version the environment has enabled and persists it, so historical records are never
reinterpreted. `src/product/shadowSemantics.ts` deletes the duplicated per-provider
comparison logic and runs the real pipeline: primitives A–E are literally
`EffectSpec.assess` → `EffectSpec.decide` → `applySafetyFloors`, with only observation
normalization being provider-specific. Shadow never reaches primitive F.

*Bug found while fixing this:* the Enforced runtime applied a dispatch-boundary retry
clamp inline that Shadow did not have, so Shadow could report a retry as permitted where
Enforced would refuse. Extracted to `applyDispatchBoundaryFloor()` in
`engine/safetyFloors.ts` and now called by both. Provider richness is preserved and
verified: GitHub inherited access → `not_applied`; Okta transitional status → fails
closed to `unprovable`; Stripe attributed → `verified`, unattributed →
`satisfied_unattributed`.

**1J — truthful readiness.** Six independent dimensions (available, enabled, configured,
credential available, preflight verified, ready) with a specific failure category rather
than a bare "not ready". `SecretProvider` (`Env`/`Test`/`Denied`) is the only path to a
credential; the resolved value is never returned, persisted or logged.
`nyst_integration_preflights` is immutable and carries a CHECK fixing
`provider_mutation_performed = false`; a probe that self-reports a mutation throws (I20).
Ready additionally requires a successful preflight inside a 12-hour TTL.

**1K — durable interventions.** `nyst_intervention_events` is immutable and keyed by a
logical `intervention_key`, so scheduler runs, repeated observations, webhook retries and
page refreshes collapse onto one row. A DB check constraint makes it structurally
impossible for a Shadow row to carry an Enforced prevention kind, or vice versa.

**1L — rate limiting.** Proven by test: after 300 requests, both `POST /v1/actions` and
`POST /v1/actions/:id/reconcile` return a single 429 and neither the committer nor the
runtime is invoked.

## Also landed (required by the above)

- Migration `0011` adds the Agent Registry schema, because 1A's contract requires a real
  `agent_breakdown` dimension. The Agent *behaviour* is Phase 6. The action→Agent binding
  is written at INSERT time into the already-immutable `nyst_action_scopes`, so a
  historical action can never be re-attributed and a cross-tenant Agent id fails a
  composite foreign key.
- `EnvironmentMode` widened to include `canary` (Phase 8 uses it; the environments CHECK
  constraint still forbids it until then).
- Optional `environment_id` sharding on the reconciliation, recovery, re-observation and
  webhook workers. This is a real deployment capability (per-tenant worker pools) and it
  also made the shared-database test suite deterministic.

## Tests updated because they encoded the defect

- Gate 8 continuation-lease test now enables `auto_continuation` before binding the
  action, and additionally asserts that the same runtime authority under
  `auto_continuation=false` yields no lease at all.
- The v0.2.1 recovery test expected the terminal invisible `failed` state; it now expects
  `needs_review` + `may_have_been_sent`, which is the point of 1D/1F.
- Shadow tests now pass the exact `spec_version` and a provider-shaped observation.

## Adversarial pass

19 attacks, all repelled: HTTP-route policy bypass, retroactive policy widening, forged
leases, unscoped scheduler resurrection, direct job insertion, suppression rewrite,
dispatch-boundary downgrade, cancelling an ambiguous recovery, forged/foreign claim
tokens, wrong expected identity on completion, DB-level terminal-state violation, stale
re-observation completion in both directions, Shadow field injection / wrong version /
unregistered effect / invalid role, DB-level Shadow-prevention insertion, intervention
mutation and duplication, mutating preflight, secret leakage into readiness/history/
metrics, missing-metric masking, and demo contamination of production metrics.

## Exit gate

- [x] every known defect has executable regression proof, written and observed failing first
- [x] focused suites pass
- [x] Gate 1–8 behaviour green (483/483, no skips)
- [x] no correctness blocker remains from the v0.2.1 audit
