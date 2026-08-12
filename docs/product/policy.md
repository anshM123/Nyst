# Policy

A policy says what Nyst is **permitted** to do on your behalf, per EffectSpec.
It is the difference between "Nyst decided a compensation is required" and
"Nyst executed a compensation".

---

## Immutable and versioned

Policies are never edited. A change creates a **new version**, recording who
made it, when, and the reason. An action captures its governing policy version
at creation time, so the record of what was allowed at the moment of the
decision cannot be rewritten afterwards.

This is enforced in the database, not by convention. An `UPDATE` against a
policy version is rejected.

---

## Effective authority is an intersection, never a union

> **effective authority = runtime authority ∩ action-bound policy authority**

Two independent sources say what may happen: the EffectSpec's runtime
disposition, and the immutable policy the action was bound to. Nyst takes the
**intersection**.

The consequence is the important part: a permission can only ever be *removed*
by adding a second source, never granted. Changing a policy cannot retroactively
widen what an in-flight action may do. Neither can changing the rollout mode,
enabling a new EffectSpec version, or anything else.

If the runtime says continuation is allowed and the policy says automatic
continuation is not permitted, continuation is not permitted. There is no
configuration that reverses that direction.

---

## What a policy controls

| Field | Effect |
| --- | --- |
| `execution_mode` | `automatic` — Nyst may act within its authority. `manual` — every consequential follow-up requires a human |
| `auto_continuation` | May Nyst authorize a continuation without a person? |
| `auto_compensation` | May Nyst execute a compensation without a person? |
| Reconciliation deadline | How long an action may remain unresolved before it escalates to human review |
| Approval requirement | Whether a human approval must have genuinely fired before dispatch |

Automatic continuation additionally requires the runtime to have concluded
`continuation_disposition: allowed`. Automatic compensation additionally
requires `primary_directive: compensate` **and** `recovery_disposition:
compensate`. Both conditions, never either.

---

## The safety floor

Every policy is intersected with a non-bypassable floor. A customer may make a
policy **stricter** than the floor. No policy, template, or API call can make
one weaker.

The floor guarantees, always:

- A blind retry is never authorized on ambiguity.
- `unprovable` never authorizes continuation.
- `pending` never authorizes continuation.
- An action that crossed the dispatch boundary is never re-dispatched on the
  strength of a lease alone.

There is no force-continue and no override. An operator with full
administrative access cannot authorize a retry that the floor forbids, because
there is no code path that expresses it.

---

## Templates

Three templates produce real versioned policies on the existing engine. They
are starting points, not special cases — a templated policy is an ordinary
policy version.

### `access_revocation`

For offboarding and permission removal. Automatic execution, never a blind
retry, continuation only once effective removal is evidenced.

The reasoning: leaving access in place is the expensive failure, so Nyst should
proceed automatically when the evidence supports it — but a retry against an
identity system risks re-applying a change someone else has since made, so
retry stays forbidden.

### `financial_action`

For refunds and captures. Automatic compensation disabled by default; ambiguity
escalates to a person.

The reasoning: an incorrectly repeated financial effect is not recoverable by
apologising, and the cost of a short delay is much lower than the cost of a
duplicate.

### `high_risk_production`

Manual execution mode. Every consequential follow-up requires a human, and the
reconciliation deadline is short so nothing sits unnoticed.

---

## Deadlines

A reconciliation deadline is not decoration. When it passes, the action
escalates into **Needs Attention** with the reason recorded. An action that
Nyst could not resolve, and that nobody was told about, is the failure mode
policies exist to prevent.

---

## Human review

When policy or the safety floor requires a person, the action opens a review.
The operations offered are exactly those the **effective authority** permits —
the same intersection, applied to the human path.

A reviewer cannot authorize a continuation the policy forbids. The dashboard
does not show the option greyed out with a tooltip promising it might work
later; the operation is not offered, because it does not exist.

Every review outcome is recorded with the actor, the operation, and the
resulting transition.

---

## Auditing

`GET /v1/policies`, or **Policies** in the dashboard, shows the full version
history: who created each version, when, why, what it changed, and which
template it came from if any.

Because versions are immutable and actions record the version that bound them,
"what was Nyst allowed to do when it made this decision?" always has an exact
answer.
