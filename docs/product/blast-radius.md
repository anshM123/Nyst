# Blast Radius

A policy decides whether a *single* action is safe. Blast Radius decides
whether the *hundredth one this hour* is.

An agent behaving correctly on every individual action can still be doing
something catastrophic in aggregate: a loop that revokes access for every user
instead of one, a retry storm that issues a thousand refunds. Every one of
those actions can be individually well-formed and individually approved.

Blast Radius is a **consequence budget** — a hard ceiling on how much
consequence an Agent may cause through an EffectSpec within a time window.

---

## Defining a budget

A budget is scoped to an Agent and an EffectSpec, with a window and a limit:

```
Agent: hr-offboarding
EffectSpec: github.repository_permission_change
Window: 3600 seconds
Limit: 30 actions
```

Two kinds of limit:

- **Action count.** Simple, and correct for access and identity effects.
- **Monetary.** Uses the structured amount from the EffectSpec. If an
  EffectSpec does not carry a structured amount, a monetary budget **fails
  closed** — it refuses the action rather than admitting it as if it were free.

---

## Admission

Every consequential action passes through admission before dispatch. If it
would exceed the budget, it is **held**, not executed, and appears in
**Needs Attention** with the budget it hit.

Admission is a ledger, not a counter. Each decision is recorded immutably with
the budget, the window, the usage at the time, and the outcome — so "why was
this held?" has an exact answer months later.

---

## Why admission is a two-statement transaction

This is the subtle part, and it is worth stating because getting it wrong is
easy and the failure is silent.

PostgreSQL's default isolation level is READ COMMITTED. Under READ COMMITTED, a
statement reads the snapshot taken **when the statement began**. A single
statement that both locks the budget row with `FOR UPDATE` and counts current
usage still counts against the pre-lock snapshot — so two concurrent callers
can each acquire the lock in turn and each see the same stale usage figure.

With a limit of 1, both are admitted.

This was a real defect, caught by a test that ran exactly two concurrent
admissions. The fix is to take the lock and read the usage in **separate
statements** within one transaction:

```sql
BEGIN;
-- Statement 1: take the row locks. Concurrent admissions queue here.
SELECT budget_id FROM nyst_blast_radius_budgets
 WHERE … ORDER BY budget_id FOR UPDATE;
-- Statement 2: a NEW snapshot, taken after the lock was granted.
INSERT INTO nyst_consequence_admissions … WHERE (usage check);
COMMIT;
```

The second statement begins after the lock is held, so its snapshot includes
every admission that committed before it. Budgets are locked in a deterministic
order (`ORDER BY budget_id`) so concurrent callers touching overlapping budget
sets cannot deadlock.

Verified with 2, 10, and 100 concurrent callers: nothing crosses the limit.

---

## Releasing a hold

A held action does not execute and does not silently expire into an execution.
Options:

- **Wait.** The window rolls forward and headroom returns.
- **Raise the budget.** Audited, and it applies to the future.
- **Cancel the action.** Also audited.

Nothing releases a hold automatically into a dispatch. A budget you set is not
a suggestion Nyst may reinterpret when it becomes inconvenient.

---

## Choosing a limit

Set it slightly above the largest legitimate burst you have actually seen, not
at a round number that feels generous. The purpose is to catch the case where
an agent is doing something qualitatively different from its normal behaviour,
and a limit set ten times too high catches nothing.

For an offboarding agent that handles at most a few departures an hour, 30 per
hour is roomy and still stops a runaway loop within seconds.

---

## Blast Radius and Freeze

Different instruments for different situations.

| | Blast Radius | [Emergency Freeze](freeze.md) |
| --- | --- | --- |
| Scope | One Agent × one EffectSpec | An entire environment or a named scope |
| Trigger | Automatic, on the budget | A human, deliberately |
| Purpose | A ceiling you set in advance | Stopping something happening right now |

Both hold new consequence and leave read-only reconciliation of existing
ambiguous actions running, because abandoning an ambiguous action mid-flight
would make things worse rather than safer.
