# Emergency Freeze

One control, one purpose: **stop new consequence now**.

When an agent is misbehaving and you do not yet know why, the useful action is
not to debug it — it is to make it stop changing things while you find out.

---

## What a freeze does

- **No new consequential action executes** in the frozen scope. Incoming
  actions are held and recorded, not silently dropped.
- **Existing ambiguous actions keep reconciling.** Reconciliation is read-only
  observation. Stopping it would strand actions in `pending` and leave you with
  *less* information at exactly the moment you need more.
- **The dashboard says so, loudly**, on every page, with the scope, who
  activated it, when, and the stated reason.
- **It survives restart.** A freeze that a process restart could clear would be
  useless in the situation it exists for.

---

## Activating

**Settings → Emergency Freeze**, or `POST /v1/freezes`. A reason is required —
the person who finds this at 3am needs to know what you knew.

Activation is immediate. The linearization boundary is the freeze record
itself: an action either admits before the freeze commits or it does not admit
at all. There is no window in which an action slips through because it was
"already in progress" at the application layer.

Verified with 100 concurrent incoming actions against a freeze: nothing crosses
the boundary.

---

## Releasing

Releasing requires **explicit confirmation and a reason**. It is not a toggle.
Turning enforcement back on after an incident should require the same
deliberateness as turning it off, because it is the more dangerous of the two
directions.

### Exactly one active freeze per scope

Four partial unique indexes guarantee that a scope has at most one active
freeze at a time. This prevents an ABA sequence — freeze, release, freeze —
from producing two overlapping authorities where releasing one appears to lift
the freeze while another is still notionally active.

Freeze and release are both fully audited.

---

## Scopes

A freeze can cover an entire environment, or a narrower named scope. A scoped
freeze stops only its own scope; other scopes continue normally.

Use the environment-wide freeze when you do not yet know what is wrong. That is
its job, and narrowing the scope prematurely is how you discover afterwards
that the problem was somewhere else.

---

## What a freeze is not

- **Not a rollback.** Effects already applied are still applied. Freeze stops
  the next one; it does not undo the last one.
- **Not a pause on Nyst.** Nyst keeps observing, reconciling, resolving, and
  signing receipts. It stops *dispatching*.
- **Not a substitute for [Blast Radius](blast-radius.md).** Blast Radius is a
  ceiling you set in advance and that acts automatically. Freeze is a human
  pulling a handle.

---

## During an incident

1. **Freeze the environment.** Reason: what you actually observed, not a
   diagnosis you have not made yet.
2. **Read Needs Attention.** Held actions, open reviews, and overdue
   reconciliations are all there.
3. **Let reconciliation finish.** Ambiguous actions will resolve as observation
   catches up, and the picture usually clarifies on its own.
4. **Work out what happened** from the evidence and the receipts, which are
   still being written.
5. **Fix the cause** — policy, blast-radius budget, agent code, EffectSpec
   enablement.
6. **Release**, with a reason that records what you found.

Consider narrowing the rollout mode back to [Canary](rollout-modes.md) for the
affected workload before releasing, rather than returning straight to full
Enforced.

---

## After restoring a backup

If you have just [restored](backup-and-restore.md) to an earlier point, Nyst
has forgotten effects that really happened. Freeze **before** starting the
workers, let reconciliation rebuild its picture of the world, and release once
the backlog has settled. Otherwise Nyst will be admitting new consequence while
still discovering the consequence it already caused.
