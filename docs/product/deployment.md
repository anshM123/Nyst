# Production deployment

Nyst v0.2.1 requires Node.js 22+ and PostgreSQL. Run the product API and the dedicated worker as separate production processes. The worker performs observation-only reconciliation, decision-webhook delivery, explicitly authorized narrow recovery, and human-requested re-observation.

```sh
npm ci
npm run migrate
npm run typecheck
npm run build
npm run start:product
npm run start:worker
```

Required configuration includes `DATABASE_URL`, a durable Ed25519 receipt-signing key source, session security values, and provider/webhook credential references. The included provider credential-source implementations resolve only the documented `env:` references; tests inject in-memory credential sources through the same interfaces. Nyst does not ship an AWS, GCP, or Vault implementation. A production deployment must inject a provider-specific credential-source adapter backed by its secret manager rather than assuming that storing a `vault:` label makes it resolvable. `NYST_LOCAL_EPHEMERAL_SIGNING=true` is development-only: receipts signed before a restart cannot validate under the next ephemeral key. Never place raw credentials in source, logs, action input, evidence, receipts, or database rows.

`GET /health` reports process health. `GET /ready` checks database readiness. Termination signals stop accepting work and close the HTTP server, worker loop, and PostgreSQL pool. Run migrations as a distinct release step before new instances become ready.

Use TLS at ingress, restrict database network access, retain append-only evidence/resolution backups, rotate API keys and webhook secrets, and monitor structured JSON logs without request bodies or authorization headers. The deterministic fake provider must remain disabled in production.

Rollback application code only to a version compatible with every applied forward migration. Migrations `0008_design_partner_product.sql` and `0009_product_correctness.sql` are additive; do not drop immutable bindings, resolution transitions, control events, recovery work, or append-only audit records during rollback.
