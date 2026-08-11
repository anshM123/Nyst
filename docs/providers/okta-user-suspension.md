# Okta user suspension — Gate 5 provider semantics

Status: semantic design for `okta.user_suspension_change/1.0.0`, researched against current official Okta documentation on 2026-08-07. Local implementation and live verification status are tracked in `BUILD_STATE.md`.

## Official references and current facts

- [User Lifecycle API](https://developer.okta.com/docs/api/openapi/okta-management/management/tags/userlifecycle) — lifecycle operations are non-idempotent state transitions; suspend is permitted only from `ACTIVE`, unsuspend only from `SUSPENDED`, and both return `200` with no content on success.
- [Users API / API reference](https://developer.okta.com/docs/api/) — retrieve the exact user by stable ID before lifecycle mutation; `X-Okta-Request-Id` exists for request debugging and System Log correlation.
- [User status reference](https://developer.okta.com/docs/api/openapi/okta-management/management/tags/user) — current statuses are `STAGED`, `PROVISIONED`, `ACTIVE`, `RECOVERY`, `PASSWORD_EXPIRED`, `LOCKED_OUT`, `SUSPENDED`, and `DEPROVISIONED`.
- [OAuth service-app guide](https://developer.okta.com/docs/guides/implement-oauth-for-okta-serviceapp/-/main/) — Client Credentials with `private_key_jwt` is the supported service-app flow for Okta scopes; service apps require admin-role assignment.
- [OAuth API access setup](https://developer.okta.com/docs/guides/set-up-oauth-api/main/) — Okta recommends scoped OAuth rather than SSWS; org-authorization-server access tokens have a fixed one-hour lifetime.
- [Okta DPoP guide](https://developer.okta.com/docs/guides/dpop/nonoktaresourceserver/main/) and [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) — a DPoP-bound token requires a fresh proof for every request, with public JWK, method, URL, unique `jti`, issued-at time, and access-token hash; servers may require a nonce challenge.
- [Permissions catalog](https://developer.okta.com/docs/api/openapi/okta-management/guides/permissions) — custom roles expose `okta.users.read`, `okta.users.lifecycle.suspend`, and `okta.users.lifecycle.unsuspend` permissions.
- [Roles guide](https://developer.okta.com/docs/api/openapi/okta-management/guides/roles) — a service app can be bound to a least-privilege custom admin role and resource set.
- [User role assignments](https://developer.okta.com/docs/api/openapi/okta-management/management/tags/roleassignmentauser) — `GET /api/v1/users/{id}/roles` uses `okta.roles.read` and can prove the disposable fixture has no active admin-role assignment.
- [Rate limits](https://developer.okta.com/docs/reference/rate-limits/) — excess requests return `429` until the bucket resets; response rate-limit headers expose reset information.
- [System Log query](https://developer.okta.com/docs/reference/system-log-query/) and [event types](https://developer.okta.com/docs/reference/api/event-types/) — lifecycle events and transaction identifiers exist, but time proximity is not action attribution.
- [Find your Okta domain](https://developer.okta.com/docs/guides/find-your-domain/main/) and [Okta organizations](https://developer.okta.com/docs/concepts/okta-organizations/) — standard org domains use `*.okta.com`, `*.oktapreview.com`, or `*.okta-emea.com`; Integrator Free Plan orgs currently use `integrator-<digits>.okta.com`.
- [Integrator Free Plan defaults](https://developer.okta.com/docs/reference/org-defaults/) — current free developer orgs do not expire, but deactivate after 180 consecutive days without a user sign-in; they allow at most ten active users and have reduced rate limits.

The lifecycle reference does not document suspend or unsuspend as asynchronous. It explicitly describes the lifecycle family as a mixture of synchronous and asynchronous operations and documents asynchronous behavior for operations such as activation/deactivation, but not for suspend/unsuspend. Nyst nevertheless treats a successful response as execution evidence only and independently reads current user state.

## Exact external promise and transition matrix

The EffectSpec controls one existing, stable Okta user in one supported Integrator Free Plan tenant. Its exact goal is `desired_status = active | suspended`:

| Observed status | Desired status | Operation |
| --- | --- | --- |
| `ACTIVE` | `active` | Observe only; goal preexists |
| `ACTIVE` | `suspended` | One `POST .../lifecycle/suspend` |
| `SUSPENDED` | `suspended` | Observe only; goal preexists |
| `SUSPENDED` | `active` | One `POST .../lifecycle/unsuspend` |

Every other current or future status is unsupported. It produces no lifecycle mutation and fails closed. Gate 5 does not create, activate, unlock, recover, reset, deactivate, delete, assign groups/apps, or manipulate passwords/MFA.

## Identity and supported topology

Semantic identity is the canonical tenant origin plus stable Okta user ID plus normalized desired status. The caller business key remains an independent logical key. Credentials, login, email, timestamps, and fault controls are not semantic identity.

Version 1.0.0 accepts only the default Integrator Free Plan origin shape `https://integrator-<digits>.okta.com`, with HTTPS, no user information, port, query, fragment, or path. Custom domains, preview domains, EMEA domains, trial domains, arbitrary Okta-looking hosts, and redirects are rejected in v1. This is intentionally narrower than Okta's full domain support and removes an arbitrary-origin SSRF surface.

The target must be an existing Okta-sourced synthetic user, identified by its stable `id`, with no active admin-role assignment. The test user must differ from all human and service-administration identities. `profile.login` and `profile.email` are corroborative mutable metadata only. A changed login with the same stable ID does not redirect the action; a different stable ID always fails closed.

The authoritative current state source is `GET /api/v1/users/{id}` by stable ID, not list/search results, HAL link presence, local dispatch state, or login/email lookup. The current `status`, absence of a conflicting `transitioningToStatus`, stable `id`, canonical tenant origin, and supported source are checked.

## Authentication and credential lifetime

Production use is an OAuth 2.0 API Services app using Client Credentials and `private_key_jwt`. Okta's current lifecycle endpoints declare `okta.users.manage`; this broad OAuth scope is therefore required even though it is not the narrowest conceptual permission. `okta.roles.read` is additionally required to verify that the disposable target is not an administrator. No separate `okta.users.read` scope is required because `okta.users.manage` includes reads.

The service app must be assigned a custom admin role/resource set limited to the target fixture (or a dedicated fixture group) with only:

- `okta.users.read`
- `okta.users.lifecycle.suspend`
- `okta.users.lifecycle.unsuspend`
- read-only role-assignment visibility needed for the fixture topology check

Do not enable the setting that automatically grants service apps `SUPER_ADMIN`. Access tokens from the org authorization server last one hour. Gate 5 resolves a short-lived access token from the process environment at request time through `env:NYST_OKTA_ACCESS_TOKEN`; token minting/private-key custody is outside semantic input and persisted state.

Bearer tokens remain supported. When the service app requires DPoP, an ephemeral DPoP private JWK is held only in process memory/environment and each request receives a fresh RS256 proof bound to the exact method, query-free target URL, unique `jti`, issued-at time, and SHA-256 access-token hash. The proof header contains only the public JWK. A valid nonce learned from Okta is cached per tenant origin. A `GET` may repeat once only after an exact `401` DPoP `use_dpop_nonce` challenge; a lifecycle `POST` is never automatically resent for nonce negotiation. Preflight reads therefore prime the nonce before consequence, while an unexpected POST challenge fails closed after exactly one POST.

The access token, application private key, ephemeral DPoP private key, client assertion, Authorization/DPoP headers, and raw credential payload must never enter action input, DispatchPlan, evidence, resolution, logs, errors, fixtures, or Git.

## DispatchPlan and consequence boundary

Preflight reads and validates the origin, stable user ID, supported source/topology, admin-role absence, current status, legal transition, and credential reference. The resolved semantic input is then committed. Before any lifecycle request, Nyst durably persists:

- provider `okta`
- API path version `v1`
- canonical tenant origin
- stable user ID
- normalized desired status
- fixed operation `observe_only`, `suspend`, or `unsuspend`
- preflight status and non-secret login metadata
- consistency deadline
- credential reference `env:NYST_OKTA_ACCESS_TOKEN`
- Nyst action correlation metadata

Restart cannot regenerate another operation, change tenants/users, or reinterpret against a later EffectSpec version. Reconciliation is observation-only and never calls a lifecycle endpoint.

## Evidence, state, and attribution

A successful lifecycle response proves only that Okta accepted/processed that request enough to return success. It is corroborative provider-response evidence, not external state truth. `X-Okta-Request-Id` is retained as safe correlation/debug metadata when available, but it does not by itself prove the resulting current status.

Independent, identity-checked user read-back establishes exact current goal presence or absence. `lastUpdated` and `statusChanged` can corroborate freshness but are not action attribution. The System Log offers `user.lifecycle.suspend`/`unsuspend`, transaction IDs, actors, clients, and request correlation, but version 1.0.0 deliberately does not request `okta.logs.read` or claim a robust one-to-one event binding. Time proximity alone is insufficient. Consequently `verified` is intentionally unreachable in v1.

- `satisfied_unattributed`: an authoritative current user read proves the exact desired `ACTIVE` or `SUSPENDED` status and identity. Retry is forbidden. Continuation is allowed for this exact goal only after current sequence/evidence revalidation.
- `pending`: a mutation may have crossed the consequence boundary and current read still shows the prior supported state inside the consistency window; or current observation is rate-limited/temporarily unavailable. Retry and continuation are blocked. A bounded `next_check_at` may be persisted.
- `not_applied`: after the consistency window, authoritative identity-checked current evidence proves the exact desired status is absent. Automatic retry remains unavailable unless runtime evidence also proves the prior request definitely was not sent.
- `unprovable`: identity, tenant, authentication, authorization, supported source/status, topology, or coherent provider truth cannot be established. Retry and continuation are blocked.
- `compensated`: unsupported. A separate opposite action is restoration, not compensation of the original action.
- `verified`: unreachable in version 1.0.0.

Duplicate provider observations are material-fact deduplicated. A later materially different observation supersedes the prior snapshot while retaining history. Contradictory active authoritative status facts fail closed rather than selecting the desired one.

## Error and consistency semantics

- `400`: lifecycle precondition/rejection evidence only; never proof of current status.
- `401`: authentication failure; no effect truth. An exact DPoP nonce challenge may cause one bounded read retry, but never an automatic lifecycle POST resend.
- `403`: scope/admin-role/policy denial; no effect truth. It is not automatically retryable.
- `404`: no absence claim unless tenant and stable identity prerequisites were independently established. A later 404 after preflight is treated as unprovable, not user absence or `not_applied`.
- `429`: observation becomes pending/hold, no redispatch, continuation blocked. Use `Retry-After` first when present, then `X-Rate-Limit-Reset`, then a deterministic one-minute default, clamped to one through five minutes.
- `500`, `502`, `503`, malformed JSON, oversized body, timeout, and reset: no effect truth.
- A definitely pre-send transport failure permits a controlled retry only after authoritative current evidence proves the goal absent and the runtime's current evidence/sequence guard still authorizes it.
- A may-have-been-sent failure never permits blind retry. Reconcile first.

One observation pass is bounded and never sleeps or loops. `next_check_at` is a persisted scheduling hint; Nyst still has no production scheduler/worker that automatically invokes reconciliation. Current official docs do not guarantee suspend/unsuspend convergence timing, so v1 uses a conservative five-minute consistency window and bounded explicit reconciliations.

## HTTP and origin safety

Requests use fixed, encoded paths under the validated canonical origin. The client permits `GET` and `POST` only, rejects redirects, sets a bounded timeout and response-size limit, sends only an allowlisted header set, parses JSON as untrusted data, and persists only allowlisted response metadata (`X-Okta-Request-Id`, `Retry-After`, `X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset`). `DPoP-Nonce` and `WWW-Authenticate` are consumed transiently for bounded authentication negotiation and never enter provider evidence. Provider error bodies are not persisted or reflected in exceptions because official Okta documentation warns that error JSON may contain user input.

## Continuation boundary

For a suspension goal, offboarding may continue only when a current authoritative read proves the same stable user is exactly `SUSPENDED`. For an activation goal, continuation requires exact `ACTIVE`. Unsupported, prior, stale, pending, contradictory, authentication-failed, or identity-mismatched evidence blocks continuation. As in Gate 4, Nyst authorizes at the check moment but does not atomically own the caller's later external consequence; the consumer must revalidate immediately before acting.

## Live fixture requirements

Live proof requires a dedicated Integrator Free Plan org, one synthetic non-admin Okta-sourced user with no meaningful applications/data, baseline `ACTIVE`, and an API Services app constrained as described above. The normal canary is one `ACTIVE -> SUSPENDED` action and a separate `SUSPENDED -> ACTIVE` restoration action. The bounded response-loss canary repeats a real suspend once, deliberately loses the response locally, restarts/reconciles without redispatch, then restores with a separate action. The fixture must finish independently observed as `ACTIVE`; no user, group, app, credential, or admin assignment may be deleted or changed.
