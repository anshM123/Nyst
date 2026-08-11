# Phase 0 — v0.2.1 baseline audit (internal)

Baseline commit: `92a1cf0` (archive as supplied, unmodified).

## Verified baseline facts

- `npm run typecheck` clean.
- `npm test` without `DATABASE_URL`: **376 pass / 0 fail / 0 skip**.
- `npm test` with local PostgreSQL 17.2 and migrations `0001..0009` applied from an empty
  database: **444 pass / 0 fail / 0 skip**. The 68 extra tests are the PostgreSQL
  integration suites, so the baseline genuinely exercises the database layer.
- 32 tables. Engine tables are `outcome_*`; product control-plane tables are `nyst_*`.
- Source is ~1.0 MB across `src/`, `tests/`, `db/`, `scripts/`, written in a very dense
  long-line style. Line counts badly understate file size; use byte counts.

## Feature map

### A. Complete + correct (preserve, do not refactor for taste)

- Six-state `EffectState` enum, closed (`src/model/effectState.ts`).
- `ControlDecision` as a genuinely separate axis with `retry`/`continuation`/`recovery`
  dispositions (`src/model/controlDecision.ts`).
- Non-bypassable safety floors (`src/engine/safetyFloors.ts`) applied after EffectSpec
  proposals; specs can only be stricter.
- Append-only evidence with `supersedes_evidence_id`, DB-enforced.
- Ed25519 receipt signing + verification.
- Provider EffectSpec semantics for GitHub / Okta / Stripe refund / Stripe capture,
  including inherited-access, lifecycle, and monetary attribution handling.
- Tenant scoping tables and `nyst_action_scopes` ownership-before-dispatch.
- DNS/IP-pinned outbound webhook target validation (`validateWebhookTarget`,
  `privateAddress`).
- `nyst_resolution_transitions` and transition-driven webhook outbox.
- Immutability triggers on `nyst_control_events` and the v0.2.1 semantic records.

### B. Complete but needs regression proof

- Rate-limit middleware returns `reply.code(429).send(...)` from an `onRequest` hook.
  The Fastify 5 contract makes this correct, but there is **no test** proving the route
  handler never runs. (Phase 1L.)
- Webhook SSRF defence has unit coverage of the URL validator but the delivery worker's
  actual socket pinning needs re-proof. (Phase 22.)
- Offboarding coordinator stage order is implemented but not pinned by a test. (Phase 20.)

### C. Partial

- `nyst_recovery_executions` has `status` in
  `{authorized, executing, completed, failed}` only, plus `claim_token`/`claimed_until`.
  There is **no persisted dispatch boundary**, so a crash mid-recovery cannot be
  classified. (Phase 1D/1F.)
- `nyst_reobservation_jobs` has claim columns but no attempt counter. (Phase 1G.)
- `nyst_shadow_evaluations` stores `effect_name` but **not `spec_version`**. (Phase 1H.)
- Environment `mode` check constraint allows only `{shadow, enforced}`; there is no
  Canary. (Phase 8.)
- Onboarding exists as a progress query but not as a guided path. (Phase 24.)

### D. UI-only / not backed by real backend truth

- Overview "Recent interventions" section renders `listActions(limit 8)` — the most
  recent actions, not durable intervention records. (Phase 1K.)
- `testIntegration()` returns `status: "credential_ready"` purely from
  `typeof env[VAR] === "string"`, and explicitly reports
  `read_only_preflight_performed: false`. Integrations UI nonetheless surfaces
  `last_verified_at` as verification. (Phase 1J.)

### E. Incorrect — launch blocking

1. **1A metric contract break (confirmed).** `GET /` renders `overviewPage()` from
   `impactMetrics()`. `impactMetrics()` returns `unsafe_retries_prevented_enforced`.
   `dashboard.ts:11` reads `data.unsafe_retries_prevented ?? 0`, which is always
   `undefined` in Enforced, so the card always renders **0** no matter how much real
   Enforced prevention is persisted. A second, differently-defined
   `unsafe_retries_prevented` also exists in `overview()` (`ambiguous AND
   retry_disposition='forbidden'`), giving two competing definitions of the same word.
   `overview()` additionally fails to exclude demo environments.

2. **1B continuation-lease policy bypass (confirmed).**
   `issueContinuationLease()` (productRepository.ts:306) requires
   `r.continuation_disposition='allowed'` but never consults the action-bound policy.
   `authorizeRecovery()` *does* check `p.auto_continuation`. So
   `POST /v1/actions/:id/continuation-leases` grants automatic continuation authority
   under `policy.auto_continuation = false`. Violates I7.

3. **1C reconciliation resurrection (confirmed).**
   `escalateOverdueReconciliations()` deletes the job row, but
   `NystReconciliationScheduler.sync()` unconditionally re-inserts from
   `outcome_runtime.next_check_at`. The suppression is not durable, so the next
   `sync()` — or any process restart — resurrects automatic reconciliation after the
   policy deadline escalated the action.

4. **1D/1F recovery strand (confirmed).** `claimRecovery()` selects only
   `status='authorized' AND claim_token IS NULL`. A worker that crashes after claiming
   leaves `status='executing'` forever: no expiry path, no reclaim path, no terminal
   path. Violates I12. Because recovery can cause an external consequence, the fix
   must not be a naive `executing → authorized` flip.

5. **1E recovery ABA (partial).** `completeRecovery()` matches `claim_token` and
   `status='executing'`, which blocks the simplest stale completion, but it does not
   pin expected action / recovery operation / policy version / resolution sequence /
   evidence sequence, and there is no test for the A-crashes-B-reclaims-A-wakes race.

6. **1G re-observation strand (confirmed).** `claimReobservation()` selects only
   `status='requested'`. Read-only work that crashed while `executing` is
   unreclaimable, so it strands permanently despite being perfectly safe to retry.

7. **1H shadow version substitution (confirmed).** `recordShadowEvaluation()` checks
   only `nyst_environment_effect_specs.enabled`; it never checks or persists the exact
   `spec_version`. Historical Shadow records cannot be reinterpreted against the
   version that was actually enabled.

8. **1I shadow semantic drift (confirmed).** `assessEffectShadow()` in
   `controlPlane.ts` is hand-written per-provider comparison logic that duplicates —
   and can silently drift from — the real EffectSpec `assess()` / safety-floor
   pipeline used by Enforced.

9. **1J readiness overclaim (confirmed).** No distinction between available / enabled /
   configured / credential-available / preflight-verified / ready. Credential presence
   is inferred from an environment variable string check with no resolution attempt and
   no preflight record.

### F. Missing

Agent Registry; Canary mode; Blast Radius; Emergency Freeze; policy templates; Go-Live
readiness; Incident Inbox; Protection Report; Proof Pack; Slack; canonical metrics
service; idempotency keys; SecretProvider abstraction; persistent signing identity;
`packages/sdk`; Dockerfile; worker heartbeats/queue observability.

## Environment constraints for this build

- No Docker and no system PostgreSQL. Resolved by installing portable PostgreSQL 17.2
  binaries and running a private cluster on `127.0.0.1:55432`.
- The cluster must be started from PowerShell. Starting it from the Git-Bash
  environment makes backend re-exec fail with `0xC0000142` (DLL init failure) on every
  client connection.
