# Phases 2–5 (internal completion note)

Suite: **501 pass / 0 fail / 0 skip**.

## Phase 2 — unified worker lease discipline

All four queues now share one vocabulary — `claim_token`, `claimed_until`, `attempt`,
`status`, stale-token rejection, lease expiry, reclaim rule — without being forced into
one generic table, because the SAFETY of a reclaim differs by operation:

| Queue | Consequence | Reclaim rule |
|---|---|---|
| Reconciliation | read-only | automatically reclaimable on lease expiry |
| Re-observation | read-only | automatically reclaimable; attempts bounded, then `needs_review` |
| Webhook delivery | idempotent event identity | retry/reclaim permitted; at-least-once |
| Recovery | **may cause an external consequence** | reclaim ONLY per the durable dispatch boundary |

Consequence safety is deliberately not generalised. A reclaimed recovery whose boundary
says `may_have_been_sent` is moved to `observing` and can only observe.

## Phase 3 — clock / lease safety

Every cross-process ownership and expiry comparison is a database-side `now()`
comparison. Proven by moving the application clock a full day backwards mid-flight: a
live lease stays live, and a worker paused beyond its lease cannot complete after another
worker reclaimed. Nyst continues to report `clock.trusted = false` and
`source = local_system_clock`; no cryptographic time claim is made anywhere.

## Phase 4 — control-plane idempotency

`nyst_idempotency_keys` scoped to (environment, operation, key) with the request hash
pinned. Four outcomes: first call runs; exact replay returns the stored response without
re-running; the same key with different parameters is a 409 rather than a silent replay;
in-flight is a 409 retry-shortly. A failed operation releases its reservation so the key
is reusable rather than permanently burned. Wired into API-key creation, policy versions,
webhook configuration, environment mode, integration configuration, Human Review
commands, Failure Lab runs, and recovery authorization.

Consequential SDK actions are deliberately excluded: `POST /v1/actions` already derives
logical identity from (environment, business key) and is protected by the engine's
dispatch-before-consequence machinery. A second dedupe mechanism over a consequential
action would create two competing definitions of "the same action", which is the exact
confusion Nyst exists to remove.

The frontend may still disable a button while a request is in flight, but the backend is
safe independently.

## Phase 5 — direct database immutability attacks

Attacks issued straight at the persistence layer, bypassing the API. Rejected: evidence
and resolution mutation/deletion; action identity (business key, input hash, effect
name); action deletion; organization/project/environment ownership rewrites; Agent
binding removal; historical policy version edits; action→policy binding retargeting;
resolution transition and control event rewrites; recovery dispatch attempt edits;
webhook attempt edits; duplicate recovery operation identity; duplicate re-observation
identity per review; forged idempotent results.

Confirmed in the same suite that immutability did not freeze the machinery: recovery
still moves `authorized → executing → completed` and re-observation still runs, through
the product's own legal transitions.
