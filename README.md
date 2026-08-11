# Nyst

**Effect-control infrastructure for autonomous software.**

> Nyst determines what actually happened after a consequential software action — and decides what is safe to do next.

Nyst sits between autonomous software and external systems where actions change access, infrastructure, accounts, money, subscriptions, or customer state. When an operation becomes ambiguous because of a timeout, crash, lost response, or eventual consistency, Nyst observes external reality, reconciles evidence, classifies the effect, and makes an explicit control decision.

```text
INTENT → EXECUTION → OBSERVATION → RECONCILIATION → EFFECT STATE → CONTROL DECISION → RECEIPT
```

## Three non-negotiable invariants

1. One logical Nyst action must never cause duplicate external effects.
2. Nyst must never report more certainty than its evidence supports.
3. Nyst must never authorize an unsafe follow-up because transport/execution state was confused with actual external effect state.

A timeout is not proof of failure. HTTP 2xx is not proof of the intended effect. Missing evidence is not proof of non-application. Ambiguity never authorizes blind retry. Uncertainty is a valid product output.

## Two separate axes

- **Effect state** answers what Nyst knows: exactly `verified`, `not_applied`, `pending`, `compensated`, `satisfied_unattributed`, or `unprovable`.
- **ControlDecision** answers what software may do next: continue, retry, do not retry, hold, compensate, or escalate, with separate retry, continuation, and recovery dispositions.

Some internal identifiers remain `Outcome*`-prefixed because the architecture predates the Nyst name. They are retained intentionally to avoid correctness-risking churn.

## Quickstart

```sh
npm install
npm run typecheck
npm test

# PostgreSQL integration
# Start PostgreSQL, set DATABASE_URL, then:
npm run migrate
npm test
```

The current build preserves verified/frozen Gates 1–8 and applies a bounded release-hardening layer; there is no Gate 9. The normal product host routes the four frozen real effects (GitHub permission, Okta suspension, Stripe refund, Stripe capture) only when the current environment enables the exact version and has its required integration. Tenant ownership is durable before dispatch eligibility, and browser sessions can switch only among accessible projects/environments.

The public TypeScript package identity is `@nyst-ai/sdk`. Production deployment, billing, a managed secret vault, and unrelated provider effects remain out of scope. See `BUILD_STATE.md`, `docs/product/quickstart.md`, and `AGENTS.md` before changing the project.

## v0.2 design-partner product

Nyst v0.2 adds the product control plane around the frozen Gates 1–8 engine without introducing a Gate 9: honest Shadow and Enforced modes, immutable versioned conservative policies, a deterministic credential-free Failure Lab, bounded human review, signed replay-safe decision webhooks, evidence-grounded action detail, and an Effect Registry. Tenant ownership plus the action's environment mode and policy snapshot are durable before provider preparation.

v0.2.0 is the historical design-partner release. v0.2.1 is its correctness and end-to-end hardening release: canonical latest-resolution rendering, cited-current-evidence explanations, scoped control-event metrics, enforced policy deadlines, a bounded recovery worker, transition-driven webhook outbox events with IP-pinned delivery, EffectSpec-aware Shadow evaluation, and engine-derived Failure Lab results. It does not add Gate 9 or a new provider effect.

Start with the [design-partner guide](docs/product/design-partner-guide.md), then review [production deployment](docs/product/deployment.md) and [decision webhook verification](docs/product/decision-webhooks.md).
