# Shadow, Canary and Enforced

Nyst does not ask you to trust it before you can measure it. An environment is
in exactly one of three modes.

| Mode | Who controls the action | What Nyst does |
| --- | --- | --- |
| **Shadow** | Your software | Applies the real semantics and reports what Enforced would have decided |
| **Canary** | Nyst, for an explicitly named scope only | Controls that scope; everything else is uncontrolled |
| **Enforced** | Nyst | Controls every consequential action in the environment |

The mode is recorded on every action at creation time. Changing the mode never
retroactively changes what an old action was governed by, and every change is
audited with the true previous mode.

---

## Semantic parity — why a Shadow finding is a real prediction

Nyst is built from six primitives:

| | Primitive | Shadow | Canary / Enforced |
| --- | --- | --- | --- |
| A | Identity and scoping | ✓ | ✓ |
| B | Observation normalization | ✓ | ✓ |
| C | Evidence interpretation | ✓ | ✓ |
| D | EffectState derivation | ✓ | ✓ |
| E | ControlDecision, safety floors, dispatch-boundary clamp | ✓ | ✓ |
| F | Provider dispatch | — | ✓ |

Only **F** differs. A Shadow evaluation runs the same `spec.assess()`, the same
`spec.decide()`, the same safety floors and the same dispatch-boundary clamp
that Enforced Mode runs. It is not a mock, a heuristic, or a second
implementation that might drift.

That is what makes "Nyst would have blocked this retry" a claim you can act on
rather than a marketing number.

---

## Shadow

You send Nyst what your software observed and what it was about to do:

```ts
await nyst.evaluateShadow({
  effect: "github.repository_permission_change",
  businessKey: "offboard:alice@acme.com:acme/api",
  observation: {
    transport: "ambiguous",              // success | definitely_not_sent | ambiguous
    authoritative_goal_observed: null,   // null means the read was impossible — not "absent"
    attempted_retry: true,               // what your code was about to do
    attempted_continuation: false,
    provider_state: { current_permission: "write", desired_permission: "none", attributed: false },
  },
});
```

Nyst replies with the EffectState it derived, the ControlDecision Enforced Mode
would have produced, and whether your intended retry or continuation would have
been blocked.

Three rules keep Shadow honest:

- **The observation schema is EffectSpec-specific and strict.** An unknown
  `provider_state` field is rejected rather than ignored. A Shadow evaluation
  built on a field Nyst does not understand would be a guess wearing a
  number's clothing.
- **`authoritative_goal_observed: null` means the read could not be made.** It
  is not the same as `false`. Absence of proof is not proof of absence.
- **The dashboard says "detected", never "prevented", in Shadow.** Nyst did not
  control the action, and claiming credit for an outcome it did not cause would
  be the kind of fabricated metric this product exists to argue against.

Shadow findings never contribute to enforced protection counts. The two live in
separate columns on the Protection Report, permanently.

---

## Canary

Canary is **deterministic and explicitly scoped**: a rule names one Agent, one
EffectSpec, and one Environment. Actions matching that exact triple are
controlled by Nyst. Everything else in the environment is not.

```
Agent: hr-offboarding  ×  EffectSpec: github.repository_permission_change  ×  Environment: production
```

**Canary is never a percentage.** "5% of your access revocations" is not a
safety property — it means that for any given consequential action, whether it
was protected is a coin flip you cannot reason about afterwards. Nyst will not
offer it.

Properties you can rely on:

- A Canary rule for Agent A grants Agent B nothing.
- A rule for one EffectSpec grants no other EffectSpec anything.
- Rules are audited: who created them, when, and why.
- Historical actions keep the mode they were created under.

The usual path is to graduate one high-value workload first — the one whose
Shadow findings were most alarming — and leave everything else in Shadow.

---

## Enforced

Nyst controls every consequential action in the environment, regardless of
Canary scope. Canary rules become redundant, not contradictory.

---

## Choosing when to graduate

The **Go-Live Readiness** view answers this per workload rather than in the
abstract. A workload is labelled *Protected* only when every dimension is
genuinely satisfied — the EffectSpec is enabled, the integration passed a real
read-only preflight within its validity window, a policy is bound, an Agent
identity exists, and the rollout mode actually covers it.

`protected_by_nyst` is true only for the *Protected* label. Nyst will not
describe a workload as protected because it is nearly configured.

The **Protection Report** gives you the evidence for the decision:

- Enforced: what Nyst blocked, and the actions it blocked them on.
- Shadow: what Nyst detected, clearly marked as counterfactual.
- A deterministic rollout recommendation that states its inputs, so you can
  disagree with it on the facts rather than on a hunch.

---

## What does not change with mode

- Blast Radius admission, Emergency Freeze, human review, receipts, evidence
  and the audit trail apply in every mode.
- Policy authority is intersected with runtime authority in every mode. A mode
  change can never widen what an action is allowed to do.
- Demo and Failure Lab activity never contaminates any of it, in any mode.
