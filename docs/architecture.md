# Nyst — Architecture (Gate 2 runtime)

Modular monolith. Zero-runtime-dependency TypeScript core; PostgreSQL for durability; `pg` as an optional peer dependency confined to one store module. No Redis, Kafka, Temporal, Kubernetes, or microservices.

```
src/
  core/      canonicalization (ojc-1), strict validation, ids, clock attestation, Ed25519 signing
  model/     effect state (Axis 1), internal lifecycle, control decision (Axis 2),
             action identity, evidence, Day-1 metadata, OutcomeResolution
  spec/      EffectSpec abstraction (the provider-facing boundary)
  engine/    core safety floors + resolution engine
  runtime/   public commit/recover/reconcile/retry/continuation/compensation control
  store/     ledger interfaces; MemoryStore (deterministic mirror); PostgresStore
  fake/      deterministic permission EffectSpec + stateful fake provider (testing only)
db/migrations/   SQL migrations (constraints are the source of truth;
                 statically cross-checked against PostgresStore by
                 tests/schemaSync.test.ts in every `npm test`)
```

## Logical action identity

An action is identified by four separate things (`src/model/action.ts`):

- `action_id` — Nyst-generated immutable UUID.
- `effect_name` — e.g. `fake.repository_permission_change` in tests and, at Gate 3, `github.repository_permission_change`.
- `business_key` — stable caller-defined logical identity, e.g. `offboard:alice:repo_prod`.
- `input_hash` — `sha256` of the **semantically relevant** input fields, projected per the EffectSpec's `semantic_fields`, canonicalized with ojc-1 (sorted keys; caller key order can never change the hash).

Identity law: same `(effect_name, business_key)` + same semantic input ⇒ the same logical action (idempotent `recordIntent`, `created=false`). Same identity + **different** semantic input ⇒ `InputCollisionError`. An ambiguous request never silently mints a new retry identity.

Uniqueness lives **in PostgreSQL**: `UNIQUE (effect_name, business_key)` with `INSERT … ON CONFLICT DO NOTHING` + read-back + hash comparison, which is race-free under concurrent creation. The MemoryStore mirrors the same semantics behind a write mutex for dependency-free tests.

## Persist intent first

`NystRuntime.commit()` validates input against the versioned registry, computes the semantic hash, and durably records the action in `internal_state = intent_recorded` **before** any dispatch is possible. **Execution identity is persisted before dispatch too**: `prepare(action_id, plan)` atomically stores the exact provider-operation identity (correlation method/value, idempotency key) and advances to `prepared`; both stores and a DB CHECK refuse to enter `dispatching` without a stored dispatch plan. The durable runtime row then serializes dispatch ownership. Its `claimed → attempted` transition is the exact consequence boundary: a crash before `attempted` is provably not sent; a crash after it is ambiguous and recovery observes provider state instead of redispatching.

Initial dispatch and a single controlled retry share the same persisted DispatchPlan. Retry ownership is atomically guarded by the current logical resolution sequence and database-maintained evidence sequence. Evidence insertion updates that sequence in the same PostgreSQL transaction through a trigger, closing the evidence-arrival/retry TOCTOU window.

## Internal lifecycle (separate axis from effect state)

```
intent_recorded → prepared → dispatching → observing ⇄ reconciling → resolved
intent_recorded/prepared → abandoned_before_dispatch   (only BEFORE dispatch)
```

- `dispatching → observing` is taken on **both** transport success and transport failure: a transport exception is an observation, never an effect-state claim, and can never automatically produce `not_applied`.
- `reconciling → observing` loops while resolution is `pending`.
- The original Gate 1 resolver may use terminal `resolved`. Gate 2 keeps the durable runtime/reconciliation history additive: later evidence appends later immutable signed resolutions, and “current” is selected by logical resolution sequence rather than wall clock.
- Transitions are validated (`assertTransition`) and compare-and-swap guarded in both stores. The internal enum and the effect-state enum are disjoint sets validated by different schemas (tested).

## Evidence

Append-only ledger (`src/model/evidence.ts`, `outcome_evidence`). Each record: schema version, source, verification method, kind, **strength**, provider object/event ids, observed/provider timestamps, structured payload + canonical payload hash, correlation info, optional signing metadata, clock attestation, and `supersedes_evidence_id` for corrections.

- Ordering: per-action monotonic `seq`, unique in the DB (`UNIQUE (action_id, seq)`). Provider event ids are deduplicated, so redelivery cannot inflate epistemic support.
- Immutability: the database blocks `UPDATE`/`DELETE` with a trigger (on `outcome_resolutions` too — signed history is immutable); the store interfaces expose no mutation methods; MemoryStore deep-freezes records. History is never rewritten — corrections append a new record referencing the old one, and both remain. A composite foreign key `(supersedes_evidence_id, action_id) → (evidence_id, action_id)` guarantees evidence can only supersede evidence of the *same* action.
- Integrity: `payload_hash` is computed by the ledger from the payload it stores — callers cannot supply it, so a stored hash can never disagree with the stored payload.
- Strength is epistemic: `authoritative` (system-of-record read-back / signed event), `corroborative` (response bodies, consistent downstream state), `circumstantial`, `transport_only` (HTTP codes, timeouts — says something about the *request*, nothing provable about the *effect*).

## Effect-state resolution

The EffectSpec's `assess(action, evidence)` proposes: state, cited evidence, verification methods, claimed strength, and whether attribution to *this* action is established. **That self-description is untrusted input.** Before floors apply, the core validates it against the actual ledger (`sanitizeAssessment`): evidence refs that don't exist for this action are dropped (V1), refs to superseded records are dropped (V1b — superseded evidence is audit history, never current truth support), verification methods not present on cited records are dropped (V2), provider object refs not backed by cited records are dropped (V3), and the receipt's `evidence_strength` is **computed** as the strongest strength among validly cited evidence (V4) — never copied from `claimed_strength`. A buggy or rogue spec cannot put a false evidence description into a signed receipt.

Evidence carries two normalized epistemic fields: `observed_disposition` (`effect_present` / `effect_absent` / `indeterminate` — what the record, on its face, says about the *intended* effect; adapters may mark `effect_present` only when the observed state matches the intended parameters) and `attribution` (`attributed` / `unattributed` / `indeterminate` — whether this record itself ties the observation to *this* action). The **epistemic floors** consume both; a spec's `attribution_established` boolean is ignored:

- E1 — `verified` requires a cited authoritative read-back/event record with `effect_present` disposition AND `attributed` attribution *on the evidence itself*. HTTP 2xx alone, or an object existing with the wrong parameters, is insufficient.
- E1b — substantively evidenced presence without evidenced attribution degrades `verified` → `satisfied_unattributed`: the goal state exists; causation by this action is unproven. This is the natural home of "the spec merely asserted attribution".
- E2 — `not_applied` requires cited authoritative evidence with an explicit `effect_absent` assertion (e.g. an absence probe after the consistency window). Merely citing "an authoritative read" is not negative proof; missing evidence or transport errors degrade to `unprovable`, never to `not_applied`.
- E2b — a `not_applied` claim is contradicted (→ `unprovable`) when any active (non-superseded) authoritative evidence for the action observed the effect present.
- E3 — `satisfied_unattributed` requires substantive `effect_present` evidence.
- E4 — `compensated` requires both evidence of the original attributed effect and separate compensation-confirming evidence.
- E5 — `unprovable` is never rewritten into anything else by policy; it is a first-class answer, not a generic failure.

## Decision-policy resolution

The spec's `decide(...)` proposes a `ControlDecision`; **control floors** clamp it:

- `verified`: retry forbidden (a duplicate attempt is never a valid retry).
- `pending`: retry forbidden, continuation blocked, primary hold/escalate — unresolved ambiguity never silently authorizes another mutation or dependent continuation.
- `unprovable`: retry never `allowed`, continuation blocked, primary escalate/hold.
- `satisfied_unattributed`: retry forbidden; continuation allowed only if the spec declares goal-state satisfaction sufficient for this action.
- `not_applied`: retry allowed only if the spec declares the effect retry-safe *and* the epistemic floor held.
- Transport-only evidence can never authorize retry regardless of proposed state.

Every clamp is recorded as a `CORE.*` reason code and surfaced in the decision's explanation, so a resolution shows when core safety overrode provider policy. Specs can be stricter than the floors; they cannot be weaker (tested with a deliberately rogue spec).

## EffectSpec boundary

`src/spec/effectSpec.ts` encodes effect semantics; `src/runtime/provider.ts` is the execution/observation boundary. Existing actions are always recovered with their persisted EffectSpec version. Missing historical versions fail closed, and a stored DispatchPlan is reused without regeneration. The current registry includes the frozen GitHub and Okta effects and the Gate-7 sandbox-only Stripe refund and manual-capture effects; each provider remains independently versioned and narrowly scoped.

## Signing & trust model

`OutcomeResolution` is the signed Nyst product output. The internal name predates the product rename and is intentionally retained. The signable portion (everything except the signature itself) is canonicalized with ojc-1 and signed with Ed25519 (`node:crypto`). Keys come from environment/configuration (`scripts/genkeys.ts` generates local dev keys); nothing is committed. The claimed `key_id` is bound to the verifying key, so swapping only the id invalidates verification. Tests prove a legitimate resolution verifies and any mutation of signed content breaks verification. `ControlDecision` axes are additionally persisted as CHECK-constrained columns on `outcome_resolutions` for direct querying; PostgreSQL `BIGINT` money values are parsed through a safe-integer guard, never lossy `Number()` conversion.

Receipts include logical resolution and evidence sequences. Their signatures cover effect state, ControlDecision, action identity, evidence references, policy/spec versions, sequence basis, timestamps, and clock metadata. Current-resolution selection uses sequence ordering, so a backward wall-clock jump cannot resurrect an older decision. Local software keys prove tamper-evidence, **not** hardware-backed attestation; local clock attestations remain `trusted: false`.

## Gate order

Gates 1–6 are frozen. Gate 7 adds exactly two Stripe sandbox effects—full refund and final full manual capture—on the same durable dispatch/observation/reconciliation runtime. Gate 7 remains open until its bounded live sandbox canaries and cleanup proof pass; Gate 8 has not started.
