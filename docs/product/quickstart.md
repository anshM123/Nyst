# Nyst design-partner quickstart

Gate 8 runs a loopback-only control plane over the existing PostgreSQL-backed Nyst runtime. It is a real local product surface, not a mock-data dashboard.

## Start locally

1. Set `DATABASE_URL` and apply `npm run migrate`.
2. Generate Ed25519 software signing keys with `node --experimental-strip-types scripts/genkeys.ts`, then place the three output values only in the process environment. `NYST_LOCAL_EPHEMERAL_SIGNING=true` is allowed only for a disposable non-production preview.
3. For an empty product database, set `NYST_BOOTSTRAP_ORGANIZATION`, `NYST_BOOTSTRAP_ORG_SLUG`, `NYST_BOOTSTRAP_PROJECT`, `NYST_BOOTSTRAP_PROJECT_SLUG`, `NYST_BOOTSTRAP_ENVIRONMENT`, `NYST_BOOTSTRAP_ENV_SLUG`, `NYST_BOOTSTRAP_EMAIL`, `NYST_BOOTSTRAP_DISPLAY_NAME`, and `NYST_BOOTSTRAP_PASSWORD` in the process environment.
4. Explicitly configure opaque provider credential references and enable the exact EffectSpec versions for each environment. For disposable onboarding only, set `NYST_ENABLE_DEVELOPMENT_FAKE=true` outside production.
5. Run `npm run start:product` and open `http://127.0.0.1:4080`.

The bootstrap password is bcrypt-hashed before persistence. Sessions are opaque, hash-stored, HttpOnly, SameSite=Strict, and expire after 12 hours. Production mode additionally requires Secure cookies and configured signing keys.

## Create an SDK key

After session login, call `POST /v1/api-keys` with the returned CSRF token in `X-Nyst-CSRF`. The raw `nyst_...` key is returned once; only its SHA-256 digest and non-secret prefix are stored. Keys are scoped to one organization/project/environment and can be revoked.

```ts
import { NystClient } from "@nyst-ai/sdk";

const nyst = new NystClient({
  baseUrl: "http://127.0.0.1:4080",
  apiKey: process.env.NYST_API_KEY!,
});

const result = await nyst.commit({
  effect: "fake.repository_permission_change",
  businessKey: "onboarding:alice:repo-prod",
  input: {
    repository_id: "repo_prod",
    principal_id: "alice",
    desired_permission: "read",
  },
});
```

The host registers GitHub, Okta, Stripe refund, and Stripe capture with their frozen semantics. A commit is rejected before consequence unless the current environment enables that exact version and its provider integration is configured. The fake effect is opt-in development behavior and is impossible in production; the product never silently falls back to it.

Browser sessions persist a validated project/environment selection. API keys remain intentionally fixed to the project/environment chosen when the key was created, so SDK calls cannot forge or switch tenant context.

## Provider examples

- GitHub supports only private organization repositories, active members, existing direct collaborators, and standard exact roles.
- Okta supports only existing Okta-sourced non-admin fixture users and exact ACTIVE/SUSPENDED lifecycle transitions.
- Stripe supports only test-mode exact full refunds and final full manual card capture. Never provide a live Stripe key.

See the provider-specific documents under `docs/providers/` before integrating. Unsupported topology fails closed.
