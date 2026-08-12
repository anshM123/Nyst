# EffectSpec semantics

An **EffectSpec** is the versioned, provider-specific definition of a single
consequential effect. It is the only place in Nyst that knows what a particular
provider's responses mean.

An EffectSpec answers four questions:

1. **What is the intended effect?** Expressed as a goal state, not as an API
   call. "Alice has no permission on acme/api", not "POST returned 204".
2. **What evidence is authoritative for it?** Which read, of which object,
   proves the goal state — and which reads are merely corroborative.
3. **Can this action's causation be attributed?** If the goal state exists, is
   there evidence that *this* action produced it?
4. **How does that evidence map to an EffectState?**

Everything else in Nyst — policy, blast radius, freeze, receipts — is
provider-agnostic and operates on the EffectState the spec produced.

---

## Versioning

EffectSpecs are versioned and **immutable once used**. An action records the
exact `spec_version` that governed it, and that version is what Shadow replays
and what the receipt attests to.

Nyst never substitutes a different version. If an environment enables
`github.repository_permission_change@1.0.0`, an action for that effect resolves
under 1.0.0 or it does not resolve at all. Silently upgrading the semantics
under an in-flight action would change the meaning of evidence already
collected.

An environment must **explicitly enable** each EffectSpec version. Enabling is
per-environment, so staging can evaluate a new version while production keeps
the old one.

---

## The four real EffectSpecs

### `github.repository_permission_change`

Changes a principal's permission on a repository.

- **Goal state**: the principal's effective permission on the repository
  equals the desired permission.
- **Authoritative evidence**: a read of the repository collaborator permission
  for that principal.
- **Attribution**: GitHub does not expose who last changed a collaborator
  permission through the permission read. If the desired permission is already
  in place but Nyst cannot establish that this action produced it, the result
  is `satisfied_unattributed`, not `verified`.
- **Why that matters**: `satisfied_unattributed` forbids retry while allowing
  continuation. The access is correct, so offboarding may proceed; but a retry
  could overwrite a change someone else made in the meantime.

### `okta.user_suspension`

Suspends or activates an Okta user.

- **Goal state**: the user's status is `SUSPENDED` (or `ACTIVE`).
- **Authoritative evidence**: a user status read.
- **Eventual consistency**: Okta may report the prior status briefly after a
  successful change. A single contrary read is therefore `pending`, not
  `not_applied` — the difference between "not yet" and "no".

### `stripe.refund`

An exact, full refund in sandbox/test mode.

- **Goal state**: a refund object exists for the charge, for the full amount.
- **Authoritative evidence**: the refund object, matched against the intended
  parameters.
- **Attribution**: matched via the action's own identifiers. A refund that
  exists but cannot be attributed to this action yields
  `satisfied_unattributed` — the money is back, but Nyst will not let you
  re-issue a refund it cannot prove it caused.
- **Partial or differing amounts are not this effect.** A refund object that
  does not match the intended parameters is not evidence of success.

### `stripe.payment_capture`

An exact, final, full capture in sandbox/test mode.

- **Goal state**: the charge is captured for the full authorized amount.
- **Authoritative evidence**: the charge object, matched against intent.
- Same attribution rule as refunds.

### `fake` — development only

A deterministic provider used by local development and the Failure Lab. It
supports seeded scenarios (`response_lost_after_effect`, `transport_timeout`,
`eventual_consistency`, `definitely_applied`, …) so ambiguity can be rehearsed.

`NYST_ENABLE_DEVELOPMENT_FAKE=true` is **rejected** under
`NODE_ENV=production`. A fake provider must never silently stand in for a
configured real one.

---

## Evidence strength

| Strength | Meaning |
| --- | --- |
| `authoritative` | A direct read of the object the effect is defined over |
| `corroborative` | Consistent with the goal state but not decisive on its own |
| `weak` | Suggestive; never sufficient to conclude |
| `none` | No usable observation |

Only `authoritative` evidence can produce `verified` or `not_applied`. This is
invariant 2 — never report more certainty than the evidence supports —
expressed as a rule the engine enforces rather than as advice.

---

## Attribution

Attribution is a separate question from presence, and conflating the two is a
common and expensive mistake.

| Goal state | Attributable to this action | Result |
| --- | --- | --- |
| Present | Yes | `verified` |
| Present | No | `satisfied_unattributed` |
| Absent | — | `not_applied` (authoritative) or `pending` / `unprovable` |

`satisfied_unattributed` exists because "someone already did it" and "I did it"
have different safety consequences even though the world looks identical.

---

## The dispatch boundary

Before an effect is dispatched, and while recovery is being considered, Nyst
tracks how far the request got:

| Dispatch state | Meaning | Reclaim safe? |
| --- | --- | --- |
| `definitely_not_sent` | The request provably never left | Yes |
| `attempted` | Dispatch started; outcome unknown | No |
| `may_have_been_sent` | Cannot rule out that the provider received it | No |
| `ambiguous` | Conflicting signals | No |
| `completed` | A response was received | Resolved by evidence |

This boundary — not a lease expiry — decides whether a worker that reclaims an
abandoned recovery may re-dispatch it. A lease tells you nobody else is working
on it. It tells you nothing about what the previous worker already sent.

---

## Adding an EffectSpec

Not a configuration change. A new EffectSpec requires:

1. A provider client with a **read-only** observation path.
2. A definition of the goal state in terms of provider objects.
3. An attribution rule, including the honest answer when attribution is
   impossible.
4. Eventual-consistency handling, so a stale read is `pending` and not
   `not_applied`.
5. Deterministic test coverage for every ambiguity scenario the provider can
   produce — not just the happy path.
6. A version, and explicit per-environment enablement.

If step 3 has no good answer for a provider, that is not a reason to guess. It
is a reason for the spec to return `satisfied_unattributed` or `unprovable`,
and to say so in the dashboard.
