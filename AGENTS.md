# Instructions for coding agents working on Nyst

Read `docs/FOUNDING_SPEC.md` first. It is authoritative. If a proposed change conflicts with it, stop.

## Product definition

Nyst is effect-control infrastructure for autonomous software. It determines what actually happened after a consequential external action and decides what is safe to do next. It is not primarily verification, retry, idempotency, logging, observability, workflow orchestration, durable execution, or receipt generation.

Never simplify the architecture to `verify → receipt`. The canonical runtime is:

```text
intent → execution → observation → reconciliation → effect state → control decision → receipt
```

Infrastructure and access control are the flagship wedge. Gates 1–8 are PASS/FROZEN; there is no Gate 9. The active tree is a bounded post-Gate-8 release-hardening line, while frozen snapshot folders remain immutable historical evidence.

The current real EffectSpecs are `github.repository_permission_change`, `okta.user_suspension_change`, `stripe.refund`, and `stripe.payment_capture`. Gate 6 integrated offboarding and the Gate 8 API/SDK/auth/scheduler/UI exist. The deterministic fake is permitted only when explicitly enabled outside production.

## Epistemic rules

- Transport failure never proves effect failure. A timeout, reset, or 5xx does not imply `not_applied`.
- Missing evidence never proves non-application. Absence requires meaningful negative evidence after the relevant consistency window.
- HTTP 2xx never proves `verified`. Intended parameters and attribution must be evidenced.
- `unprovable` is a valid output; never convert it into a more comfortable state.
- Superseded evidence remains audit history but cannot strengthen current truth, attribution, evidence strength, provider references, methods, or control policy.
- Never weaken epistemic state or control policy to make a test or demo pass.

## Structural rules

- Exactly six external effect states live in `src/model/effectState.ts`; do not add a seventh.
- Effect state and ControlDecision are separate axes and must remain separate.
- Evidence and signed resolutions are append-only. Corrections append with `supersedes_evidence_id`.
- Core safety floors in `src/engine/safetyFloors.ts` are non-bypassable. EffectSpecs may be stricter, never weaker.
- Logical identity uniqueness and dispatch-before-consequence requirements must be enforced in PostgreSQL as well as application code.
- Persist logical intent and provider operation identity before any provider mutation.
- Never store raw credentials. Never describe local software keys as hardware-backed or local wall-clock time as trusted.

## Scope and process

- Do not invent a later gate. No new providers, billing, provisioning, or unrelated workflows are authorized by release hardening.
- Product actions must be environment-enabled and durably organization/project/environment-scoped before dispatch eligibility.
- Run `npm run typecheck` and the complete `npm test` suite before claiming success.
- When PostgreSQL is required, set `DATABASE_URL`, apply migrations from a fresh database, and require the integration suite to execute with no relevant skip.
- Update `BUILD_STATE.md` whenever functionality, verification evidence, or risks change.
- After green tests, perform an adversarial review for duplicate dispatch, stale evidence/decisions, crash windows, unsafe defaults, provider-authority bypass, signing gaps, and MemoryStore/PostgresStore divergence.
