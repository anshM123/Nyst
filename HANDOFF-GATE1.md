# Nyst Gate 1 handoff (historical frozen record)

This file records the Gate-1-era handoff and is not current roadmap authority. Gates 1–8 are now PASS/FROZEN; there is no Gate 9. Read `AGENTS.md`, `docs/FOUNDING_SPEC.md`, and `BUILD_STATE.md` for current status.

Gate 1 is frozen and independently verified against PostgreSQL 16.14. The authoritative result and environment are recorded in `BUILD_STATE.md`.

The foundation enforces logical identity, persisted dispatch identity, append-only evidence and signed resolutions, active-evidence semantics, evidence-grounded attribution and strength, six closed effect states, separate ControlDecision output, and non-bypassable safety floors.

The deterministic test provider is `fake.repository_permission_change`. It is not a GitHub integration and performs no real external operation.

Gate 2 may add the durable commit/dispatch/observe/reconcile runtime using fake providers only. Gate 3 is the first real provider: GitHub repository permission change. Never introduce real GitHub or Stripe code before its gate.

Before changing the project, read `AGENTS.md` and `docs/FOUNDING_SPEC.md`. Run migrations, strict typecheck, the complete test suite with PostgreSQL enabled, direct database attack probes, and an adversarial review before changing a gate verdict.
