# Nyst API v1

All endpoints are under `/v1`. Responses carry `X-Nyst-Request-Id`. Browser mutations require an authenticated session plus `X-Nyst-CSRF`; SDK requests use `Authorization: Nyst <api-key>` and project/environment scopes.

## Actions and evidence

- `POST /v1/actions` — commit a logical action through the configured Nyst runtime.
- `GET /v1/actions` — list tenant-scoped actions; optional `provider`, `effect`, `state`, `decision`, `since`, and `limit` filters.
- `GET /v1/actions/:id` — persisted intent, immutable DispatchPlan identity, and runtime state.
- `GET /v1/actions/:id/evidence` — append-only evidence in sequence order.
- `GET /v1/actions/:id/resolutions` — signed resolution progression.
- `GET /v1/actions/:id/receipt` — latest machine-readable receipt plus local verification result.
- `GET /exports/:id` — authenticated JSON download of the latest receipt and verification result.
- `POST /v1/actions/:id/reconcile` — observation/reconciliation only; it does not redispatch.

## Control and configuration

- `POST /v1/actions/:id/continuation-leases` — issue a 30-second, one-use lease bound to the current resolution and evidence sequences.
- `POST /v1/continuation-leases/consume` — atomically consume only if those sequences remain current. This proves authorization at consumption time; it does not claim impossible distributed atomicity with a later external consequence.
- `GET /v1/effect-specs` — exact enabled and integration-available semantics for the current environment.
- `PUT /v1/effect-specs/:effect` — session-only environment enable/disable for the registered exact version; production rejects the fake provider.
- `GET /v1/context` and `POST /v1/context` — list accessible project/environment context and persist a validated browser-session selection. Cross-organization guesses return 404.
- `GET /v1/integrations` — configured status and opaque credential references only.
- `PUT /v1/integrations/:provider` — store an `env:`, `vault:`, or `secret-manager:` reference; raw credentials are rejected by validation and database constraints.
- `POST /v1/integrations/:provider/test` — validate the configured reference topology and whether an `env:` reference is available to this process; it is a non-mutating readiness check, not proof of provider authorization for vault-backed references.
- `PUT /v1/environment/mode` — confirmed Shadow/Enforced mode change with immutable audit history.
- `POST /v1/shadow/evaluations` — store an EffectSpec-specific observed-fact and counterfactual assessment; Shadow never claims prevention.
- `POST /v1/policies` — append a conservative immutable policy version.
- `PUT /v1/webhooks/decision` and `POST /v1/webhooks/decision/test` — configure a secret reference and queue a signed real-resolution test event.
- `POST /v1/actions/:id/recovery-authorizations` — authorize only a supported sequence- and policy-bound recovery operation; the dedicated worker performs execution.
- `GET /v1/reviews`, `POST /v1/actions/:id/reviews`, and `POST /v1/reviews/:id` — bounded review, acknowledgement, and observation-only re-observation request.
- `GET /v1/offboarding-runs` — scoped Gate-6 coordinator runs.
- `GET /v1/overview` and `GET /v1/metrics` — real aggregate and bounded operational metrics.
- `POST /v1/api-keys` and `DELETE /v1/api-keys/:id` — one-time creation and revocation.

Unknown and cross-tenant IDs return 404. Error responses are bounded and never include provider bodies, credentials, SQL, or stack traces.

HTML dashboard routes require a session and never accept an API key as a substitute. API-key calls require the exact read/write scope documented for the endpoint; a receipt-only key cannot list actions or render dashboard pages.

`POST /v1/actions` establishes immutable organization/project/environment ownership after intent persistence and before DispatchPlan preparation or provider dispatch. Environment disablement, version mismatch, missing integration, or an unsupported credential reference fails before consequence.
