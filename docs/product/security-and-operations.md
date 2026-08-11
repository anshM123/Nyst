# Gate 8 security and operations boundary

## Tenant and credential model

Organization, project, and environment form the hard query scope. Every product action and offboarding run receives an immutable scope row. Product queries join through that row and apply all three tenant identifiers. Cross-organization guessed IDs are indistinguishable from missing IDs.

Action scope is established before DispatchPlan preparation and checked again by the product runtime before recovery, retry, compensation, or dispatch. PostgreSQL independently rejects preparation of an environment-namespaced action without the matching durable scope. An unscoped crash orphan cannot dispatch or be adopted by another tenant.

Passwords use maintained `bcryptjs` with cost 12. Nyst does not implement password cryptography. Session and API credentials are random high-entropy values; only SHA-256 digests are stored because the raw values are already uniformly random. Sessions use HttpOnly/SameSite cookies and CSRF binding. API keys are shown once, scoped, expirable, rotatable by replacement, and revocable.

Provider credentials are never accepted by the dashboard or persistence API. Integrations store only references beginning `env:`, `vault:`, or `secret-manager:`. The included runtime credential sources resolve only the exact documented environment references. Provider-specific credential-source interfaces permit a deployment to inject a managed-secret adapter, but this repository includes no managed-vault implementation; a stored `vault:` or `secret-manager:` reference remains unavailable until the host supplies one. Local environment references are a development boundary, not a production secret vault.

Sessions persist selected project/environment IDs under composite organization foreign keys. Context changes must match an accessible project/environment pair. API keys are immutable environment-scoped credentials and do not inherit later browser-session switches.

## Scheduler

`NystReconciliationScheduler` materializes `next_check_at` into durable jobs, claims with PostgreSQL `FOR UPDATE SKIP LOCKED`, leases ownership, clamps stale hints, preserves failure backoff across scheduler synchronization, applies bounded exponential backoff, and deletes terminal/stale work. It invokes only `runtime.reconcile`; it has no mutation dispatch path.

## Continuation

Continuation leases last 30 seconds, are single-use, and bind action, resolution ID, resolution sequence, and evidence sequence. Consumption rechecks current PostgreSQL state atomically. External state can still change after consumption; Nyst explicitly does not claim distributed atomicity with an arbitrary consumer.

## Policy deadlines and recovery

Every action binds an immutable policy version and deterministic reconciliation deadline before provider preparation. Deadline expiry may require human review and stop automatic observation, but it never invents a new external EffectState. The recovery worker claims with PostgreSQL locking, revalidates current sequences and historical policy authority immediately before execution, and uses a stable downstream operation key. Once execution becomes ambiguous, Nyst records failure for investigation and does not redispatch.

## Decision webhooks

Webhook events originate from durable resolution or lifecycle transitions rather than HTTP-route side effects. Delivery validates all DNS answers and pins the TLS connection to one validated public address without changing hostname verification. Redirects are disabled. Attempt history is append-only; retries retain the same event ID.

## Web boundary

The server uses a restrictive Content Security Policy, same-origin scripts/styles, frame denial, no-referrer policy, bounded 64 KiB bodies, parameterized SQL, opaque errors, request correlation IDs, rate limiting, recursive output redaction, and context-sensitive HTML escaping. No raw secret is returned in API or DOM responses.
