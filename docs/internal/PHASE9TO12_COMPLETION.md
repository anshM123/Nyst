# Phases 9–12 (internal completion note)

Suite: **526 pass / 0 fail / 0 skip**.

## Phase 10 — Blast Radius Guard

Three limits (max actions per window, max amount per action, max aggregate amount per
window) over three scopes (Agent, EffectSpec, Environment). Not a policy language.

Money comes only from structured EffectSpec semantics as integer minor units. A monetary
budget applied to an effect with no authoritative amount **fails closed**, and a currency
mismatch holds rather than silently comparing unlike units.

### Bug found and fixed: a real snapshot-isolation gap

The first implementation did the whole admission in one SQL statement with `FOR UPDATE`
on the budget rows. That is not sufficient. Under READ COMMITTED a statement takes a
single snapshot: concurrent callers do queue on the lock, but when the second caller
unblocks, its budget-count subquery still reads the pre-lock snapshot and misses the
admission the first caller just committed. The 2-concurrent test caught it — both callers
were admitted against a limit of 1.

The fix is a real two-statement transaction on one pooled connection: statement 1 takes
the locks, statement 2 counts and inserts under a **fresh** snapshot that includes
everything committed before it began. `admitConsequence` now requires a pool that can
open a transaction and says so loudly rather than degrading to an unsafe path.

Verified at 2, 10 and 100 concurrent callers: admitted count equals the limit exactly,
and the durable ledger agrees with the returned decisions.

## Phase 11 — Emergency Freeze

Durable, restart-safe, audited, scoped to Environment / Agent / EffectSpec.

**Linearization boundary:** a freeze is active the instant its row commits. Admission
reads committed freezes and writes the admission row in the same transaction, so there is
no interval in which a consequence is admitted after the freeze became visible. The race
test asserts the strong property directly — zero admissions with `decided_at` after the
freeze's `activated_at` — rather than the weaker "some were blocked".

Partial unique indexes allow at most one active freeze per exact scope, so freeze/
unfreeze cannot ABA into two overlapping authorities. A released freeze is immutable and
history cannot be deleted. Release requires explicit confirmation.

Read-only work is explicitly unaffected: reconciliation, evidence reads and receipt
verification all continue during a freeze, and the test asserts it.

## Phase 12 — Policy templates

Access Revocation, Financial Action, High-Risk Production. Each produces an ordinary
versioned policy through the existing engine — no second engine, no DSL. `retry_mode` is
structurally fixed at `never`, and the database refuses any policy row that would allow
automatic retry. Template provenance is written at INSERT time because policy versions
are immutable once created.

Each template also ships its guarantees AND its boundaries, so choosing one is an
informed decision rather than a marketing pick.

## Phase 9 — Protection Report

Every number comes from the canonical metric service. Enforced/Canary reality and Shadow
counterfactual are separate fields and are never summed. The report carries explicit
honesty notes, and the highest-risk incident's explanation is derived deterministically
from the persisted resolution.

The rollout recommendation (`ENFORCE` / `CANARY` / `KEEP IN SHADOW` / `BLOCKED BY
READINESS`) is pure branching over persisted facts, and returns the exact inputs it
consulted so the answer is auditable. No model is involved. Determinism is asserted over
50 identical evaluations.

Financial exposure is reported only where an EffectSpec carried an authoritative amount
AND a duplicate risk was actually demonstrated. It is never presented as a saving, and
nothing is extrapolated.

CSV export neutralises leading `=`, `+`, `-` and `@` so a downloaded report cannot
execute formulas in a spreadsheet.
