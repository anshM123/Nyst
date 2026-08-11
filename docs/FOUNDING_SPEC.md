# Nyst — Founding Specification

**Effect-control infrastructure for autonomous software.**

> Nyst determines what actually happened after a consequential software action — and decides what is safe to do next.

Nyst protects consequential changes to access, infrastructure, accounts, subscriptions, money, and customer state. The dangerous failure is ambiguity: a provider may apply a mutation while its response is lost, leaving ordinary software unable to know whether retrying, continuing, or stopping is safe.

## Runtime

```text
INTENT → EXECUTION → OBSERVATION → RECONCILIATION → EFFECT STATE → CONTROL DECISION → RECEIPT
```

- **Intent:** durably record logical identity, semantic input, context, and the bound EffectSpec version.
- **Execution:** durably record provider operation identity before any external consequence, then cross the provider boundary.
- **Observation:** append normalized transport, response, event, read-back, absence, and compensation evidence.
- **Reconciliation:** interpret active evidence with the bound EffectSpec and apply non-bypassable core safety floors.
- **Effect state:** report what current evidence supports.
- **Control decision:** separately report whether retry, continuation, compensation, hold, or escalation is safe.
- **Receipt:** sign the evidence-grounded resolution and control decision.

## Three invariants

1. One logical Nyst action must never cause duplicate external effects.
2. Nyst must never report more certainty than its evidence supports.
3. Nyst must never authorize an unsafe follow-up because transport/execution state was confused with external effect state.

Transport errors do not prove effect failure. HTTP success does not prove correct application. Missing evidence does not prove absence. A desired state can exist without attribution to this action. Uncertainty is a legitimate output.

## Closed effect-state model

There are exactly six externally visible states: `verified`, `not_applied`, `pending`, `compensated`, `satisfied_unattributed`, and `unprovable`. Internal execution lifecycle is a different axis.

Effect state answers, “What do we know happened?” ControlDecision answers, “What may software safely do next?” These structures must never be collapsed into a global state-to-action mapping.

## EffectSpec registry

An EffectSpec encodes the real-world semantics of one consequential action: logical identity, semantic input fields, correlation and provider operation identity, evidence normalization, verification and attribution rules, consistency windows, retry and continuation policy, compensation, and escalation. The accumulated registry of these semantics, combined with production evidence about provider failure behavior, is Nyst’s long-term moat.

## Verified product status

Gates 1–8 are PASS/FROZEN. There is no Gate 9. The current active work is post-Gate-8 release hardening, not a new gate. Frozen gate directories are historical records and must not be rewritten.

The deployed registry contains four real effects: GitHub repository permission change, Okta user suspension/activation, Stripe exact full sandbox refund, and Stripe exact final full sandbox capture. Gate 6 provides the narrow integrated Okta/GitHub offboarding coordinator. Gate 8 provides the tenant-scoped API, `@nyst-ai/sdk`, authentication, durable read-only reconciliation scheduler, sequence-bound continuation leases, and real-data UI.

Future destructive GitHub permission canaries use the private disposable `nyst-ai-outcomes/nyst-permission-fixture` repository. The `nyst-ai-outcomes/nyst.ai` repository is product source and must not be used as a mutation fixture.

Nyst is not primarily a retry library, idempotency wrapper, log, observability product, workflow engine, durable-execution engine, test generator, or receipt generator. Those mechanisms may support the product, but the product is the evidence-bounded effect state plus the explicit safety decision.

Internal `Outcome*` identifiers may remain temporarily from the project’s earlier name. Product-facing language and semantics are Nyst; correctness takes priority over cosmetic renaming.
