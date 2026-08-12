# SDK quickstart

Get a Nyst instance running locally and put one consequential action through
it. Fifteen minutes.

Requires Node 22+ and PostgreSQL 14+.

---

## 1. Start Nyst

```bash
npm install
```

```bash
export DATABASE_URL='postgres://nyst:nyst@localhost:5432/nyst'
npm run migrate
```

```bash
export NYST_LOCAL_EPHEMERAL_SIGNING=true
export NYST_ENABLE_DEVELOPMENT_FAKE=true
export NYST_BOOTSTRAP_ORGANIZATION='Acme' NYST_BOOTSTRAP_ORG_SLUG=acme
export NYST_BOOTSTRAP_PROJECT='Platform' NYST_BOOTSTRAP_PROJECT_SLUG=platform
export NYST_BOOTSTRAP_ENVIRONMENT='Production' NYST_BOOTSTRAP_ENV_SLUG=production
export NYST_BOOTSTRAP_EMAIL='you@acme.test' NYST_BOOTSTRAP_DISPLAY_NAME='You'
export NYST_BOOTSTRAP_PASSWORD='choose something long'
npm run start:product
```

Open <http://127.0.0.1:4080> and sign in with the organization slug (`acme`),
email and password.

Both `NYST_LOCAL_EPHEMERAL_SIGNING` and `NYST_ENABLE_DEVELOPMENT_FAKE` are
development-only and are **rejected** under `NODE_ENV=production`.

---

## 2. Get an API key

**Settings → API keys → Create.** Scopes: `actions:read`, `actions:write`,
`receipts:read`.

The raw `nyst_…` key is shown **once**. Only its SHA-256 digest and a non-secret
prefix are stored. A key is fixed to the project and environment it was created
in, so an SDK call cannot forge or switch tenant context.

```bash
export NYST_URL=http://127.0.0.1:4080
export NYST_API_KEY='nyst_…'
```

---

## 3. Install the SDK

```bash
npm install @nyst-ai/sdk
```

No runtime dependencies. Node 22+.

---

## 4. Execute a consequential action

```ts
import { NystClient } from "@nyst-ai/sdk";

const nyst = new NystClient({
  baseUrl: process.env.NYST_URL!,
  apiKey: process.env.NYST_API_KEY!,
});

const { action_id, resolution } = await nyst.execute({
  effect: "github.repository_permission_change",
  businessKey: "offboard:alice@acme.com:acme/api",
  input: {
    repository_id: "acme/api",
    principal_id: "alice",
    desired_permission: "none",
  },
});

const { effect, control } = resolution;
console.log(effect.state);         // verified | not_applied | pending | …
console.log(control.primary);      // continue | retry | do_not_retry | hold | …
console.log(control.explanation);  // why, in words
```

`businessKey` is your stable identifier for the logical action. Nyst uses it to
recognise the same logical action across retries; choose something that means
"this specific change to this specific thing".

A commit is refused before any consequence unless the environment enables that
exact EffectSpec version **and** its integration is configured. Nyst never
silently falls back to the fake provider.

---

## 5. Act on the answer

```ts
import { mayContinue, mayRetry, needsHuman } from "@nyst-ai/sdk";

if (needsHuman(control)) {
  await pageOncall(action_id, control.explanation);
} else if (mayContinue(control)) {
  await nextStep();
} else if (mayRetry(control)) {
  await retryOnce();
} else {
  // Neither continuing nor retrying is permitted. Stop here.
}
```

Read the dispositions. Do not re-derive them from the effect state.

The case that proves why: `satisfied_unattributed` gives you
`primary: do_not_retry`, `retry: forbidden`, `continuation: allowed`. The access
is gone, so proceed — but you cannot prove you removed it, so re-sending is
forbidden. No local rule of thumb reproduces that.

`retry: "unknown"` is **not** permission. It is the explicit statement that
permission could not be established, and `mayRetry` returns false for it.

---

## 6. Handle `pending`

`pending` with `hold` is Nyst working correctly. The external world has not
settled yet.

```ts
let current = resolution;
for (let attempt = 0; current.effect.state === "pending" && attempt < 12; attempt += 1) {
  await new Promise((r) => setTimeout(r, 5_000));
  ({ resolution: current } = await nyst.reconcile(action_id));
}
```

You do not have to poll. Nyst's reconciliation worker re-observes on its own
schedule; `reconcile()` just asks it to look now. For a push model, use
[decision webhooks](decision-webhooks.md).

---

## 7. See the evidence

```ts
const evidence = await nyst.evidence(action_id);          // what Nyst observed
const history  = await nyst.resolutions(action_id);       // how the answer changed
const { receipt, signature_valid } = await nyst.receipt(action_id);
```

Or open the action in the dashboard, which shows the current explanation with
the evidence it cites, and the full history beneath it.

---

## 8. Rehearse ambiguity

Real ambiguity is hard to reproduce on demand. The **Failure Lab** runs seeded
fault scenarios through the real engine:

| Scenario | What it simulates |
| --- | --- |
| `response_lost_after_effect` | The effect applied; you never learned |
| `transport_timeout` | No response at all |
| `eventual_consistency` | The read lags the write |
| `definitely_not_sent` | The request provably never left |
| `definitely_applied` | The clean case |

Run each and see what your code would receive. Results are labelled
`SIMULATED` and never contribute to protection metrics.

---

## 9. Error handling

```ts
import { NystApiError } from "@nyst-ai/sdk";

try {
  await nyst.execute(input);
} catch (error) {
  if (error instanceof NystApiError) {
    // error.status, error.response, error.requestId
    if (error.status === 429) { /* back off */ }
    if (error.status === 403) { /* scope or policy refusal */ }
  }
  throw error;
}
```

A refusal is an answer too. A held action means a Blast Radius budget or an
Emergency Freeze did its job.

---

## Next

- [Package README](../../packages/sdk/README.md) — the full client surface
- [EffectSpec semantics](effectspec-semantics.md) — what each effect means
- [Rollout modes](rollout-modes.md) — Shadow before you enforce
- [Decision webhooks](decision-webhooks.md) — push instead of poll
- [Known boundaries](known-boundaries.md) — read before relying on any of this
