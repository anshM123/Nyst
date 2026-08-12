# Design-partner deployment guide

The complete path from nothing to a protected production workload. A competent
engineer should be able to follow this without reading Nyst's source.

Plan for roughly half a day of setup, then **at least a week in Shadow** before
enforcing anything. The waiting is the point: Shadow is how you find out what
Nyst would have done to your traffic before it does it.

---

## 1. PostgreSQL

PostgreSQL 14 or newer; 17 is what this release was tested against.

- A dedicated database and role. Nyst creates and owns its own tables.
- Not reachable from the internet.
- TLS if the database is on another host.
- Backups configured *before* you put anything real through Nyst.

```
DATABASE_URL=postgres://nyst:…@db.internal:5432/nyst
NYST_DATABASE_SSL=true
```

Keep certificate verification on. If it fails, supply the CA rather than
disabling verification — production refuses to start with unverified TLS.

---

## 2. Signing identity

This is the most consequential thing you will configure, and the easiest to get
subtly wrong.

```bash
node --experimental-strip-types scripts/genkeys.ts
```

- Put `OUTCOME_SIGNING_PRIVATE_KEY_B64` in your secret store, not in a file on
  the host.
- Choose a meaningful `OUTCOME_SIGNING_KEY_ID`, e.g. `nyst-prod-2026-01`.
- Keep the **public** key somewhere permanent and backed up. Receipts signed by
  a key whose public half you lose are unverifiable forever.
- Both the web and worker processes need the identity.

A receipt signed by a key that no longer exists proves nothing. Production
therefore refuses an ephemeral identity outright. See
[receipt signing](receipt-signing.md).

---

## 3. HTTPS

Terminate TLS in front of Nyst. Set `NYST_PUBLIC_ORIGIN` to the https URL —
it must be https in production, and it is what appears in webhook and Slack
links.

Set `NYST_TRUST_PROXY=true` **only** if nothing can reach the container except
your proxy. Getting this wrong in either direction breaks rate limiting; see
[deployment](deployment.md#trusted-proxy--read-this-one-carefully).

---

## 4. Provider secrets

Nyst stores an opaque reference (`env:NYST_GITHUB_TOKEN`), never a value.

Grant the **minimum** each EffectSpec needs:

| Provider | Needs |
| --- | --- |
| GitHub | Repository Administration write, Metadata read. Fine-grained token, scoped to the repositories in play |
| Okta | Read user status, and suspend/activate. Nothing else |
| Stripe | Sandbox/test key. Never a live key for evaluation |

Only configure the providers you are actually going to use. Nyst never demands
a credential for a provider you have not enabled.

---

## 5. Start the services

```bash
docker compose run --rm migrate
docker compose up -d
```

On the web host's **first** start, set the bootstrap variables to create your
organization, project, environment and admin user, then remove
`NYST_BOOTSTRAP_PASSWORD` from the environment.

Confirm:

```bash
curl -fsS https://nyst.example.com/health
curl -fsS https://nyst.example.com/ready
```

---

## 6. Sign in and register your Agents

Sign in with the organization slug, email and password from step 5.

An **Agent** is the identity of the software that will act. Register one per
autonomous system — name, owner, framework, what it does.

This is not paperwork. Agent identity is what Canary scoping, Blast Radius
budgets, and every metric are keyed on. Two systems sharing one Agent identity
cannot be separately controlled or separately measured.

---

## 7. Enable EffectSpecs

**Effect Registry** → enable the exact version you want for this environment.

Enablement is per-environment and per-version, so staging can evaluate a new
version while production keeps the old one. Nyst never substitutes a version.

---

## 8. Verify integrations

**Integrations** → **Preflight** for each configured provider.

Preflight is a bounded, **read-only** probe. It reports the account identity it
reached, and Nyst rejects the result outright if a probe ever reports having
mutated provider state.

A green tick expires after 12 hours. That is deliberate: a tick from last week
is not evidence that a credential works today.

Fix anything that fails now. An integration that cannot read cannot reconcile,
and an action Nyst cannot reconcile becomes `unprovable`.

---

## 9. Bind a policy

**Policies** → start from a template:

| Template | For |
| --- | --- |
| `access_revocation` | Offboarding and permission removal |
| `financial_action` | Refunds and captures |
| `high_risk_production` | Anything where a human should see every follow-up |

You may make a policy **stricter** than the template. You cannot make it weaker
than the safety floor — no policy, template, or API call can. See
[policy](policy.md).

---

## 10. Set a Blast Radius budget

**Settings → Blast Radius**. One per Agent × EffectSpec.

Set it slightly above the largest legitimate burst you have actually observed.
A limit set ten times too high catches nothing. See
[Blast Radius](blast-radius.md).

---

## 11. Shadow first

The environment starts in **Shadow**. Your software keeps full control.

Send Nyst what you observed and what you were about to do:

```ts
await nyst.evaluateShadow({
  effect: "github.repository_permission_change",
  businessKey: `offboard:${user}:${repository}`,
  observation: {
    transport: "ambiguous",
    authoritative_goal_observed: null,   // null = the read was impossible, NOT "absent"
    attempted_retry: true,
    attempted_continuation: false,
    provider_state: { current_permission: "write", desired_permission: "none", attributed: false },
  },
});
```

Run this for at least a week of real traffic. Then read the **Protection
Report**. The Shadow column tells you what Enforced Mode would have blocked —
using the same semantics, not a model of them. See
[rollout modes](rollout-modes.md).

If the Shadow findings are uninteresting, that is a real result: your workload
may not need Nyst. If they are alarming, you have found something before it
cost you.

---

## 12. Canary

**Go-Live Readiness** shows, per workload, whether every dimension is genuinely
satisfied. A workload is *Protected* only when it actually is — not when it is
nearly configured.

Graduate **one** workload: one Agent × one EffectSpec × this Environment.
Choose the one whose Shadow findings were most alarming.

Canary is never a percentage. "5% of your revocations" is not a safety property
you can reason about afterwards.

Switch that workload's integration from Shadow evaluation to real execution:

```ts
const { action_id, resolution } = await nyst.execute({
  effect: "github.repository_permission_change",
  businessKey: `offboard:${user}:${repository}`,
  input: { repository_id: repository, principal_id: user, desired_permission: "none" },
});

const { control } = resolution;
if (needsHuman(control))       await pageOncall(action_id, control.explanation);
else if (mayContinue(control)) await nextStep();
else if (mayRetry(control))    await retryOnce();
```

Read the dispositions. Do not re-derive them: `satisfied_unattributed` allows
continuation while forbidding retry, and no local rule of thumb reproduces that.

Run the Canary for a week. Watch **Needs Attention** daily.

---

## 13. Enforced

When the Canary workload has been quiet and Go-Live Readiness is green for the
rest, switch the environment to **Enforced**. Nyst now controls every
consequential action in it.

---

## 14. Emergency Freeze

Know where the handle is *before* you need it: **Settings → Emergency Freeze**.

It stops new consequence immediately, keeps read-only reconciliation running,
and survives restart. Releasing requires explicit confirmation and a reason.

Practise it once, deliberately, while nothing is wrong. See
[freeze](freeze.md).

---

## 15. Monitoring

| Signal | Where | Alert when |
| --- | --- | --- |
| Worker liveness | `/v1/operational-health` | Any of the four kinds has no heartbeat for 120s |
| Readiness | `/ready` | Non-200 |
| Needs Attention | dashboard / `/v1/needs-attention` | Anything sits unresolved beyond your policy deadline |
| Queue depth, stale leases | `/v1/operational-health` | Growing steadily |

`?format=prometheus` on operational-health if you scrape.

The worker alert is the one that matters most. An API that answers while its
workers are dead accepts consequential actions and never resolves them, and it
looks perfectly healthy from the outside.

---

## 16. Backups

```bash
pg_dump -h "$PGHOST" -U "$PGUSER" -d nyst -Fc -f "nyst-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Then actually restore one, into a different database, and verify it:

```bash
node --experimental-strip-types scripts/verifyRestore.ts
```

It re-verifies a receipt signature, which is the sharpest test of whether your
signing identity really persisted. Do this on a schedule, not after an
incident. See [backup and restore](backup-and-restore.md).

---

## 17. Upgrades

Short maintenance window: back up, stop workers, stop web, migrate, start web,
start workers. Workers stop **first** and start **last**.

There is no zero-downtime claim and no automated rollback. See
[upgrades](upgrades.md), which says exactly where a window is required.

---

## 18. Credential rotation

1. Write the new value at the **same reference** in your secret store.
2. Restart web and workers.
3. Run preflight from **Integrations**.
4. Confirm the readiness dimension is green with a fresh timestamp.

Nyst is never reconfigured for a rotation, because the reference did not
change. Rotate the **signing** identity separately from an upgrade, never in
the same window; old receipts keep verifying under the key that signed them,
and you must keep every retired public key.

---

## What to expect in the first month

- **A lot of `satisfied_unattributed`.** The goal state is present but
  causation cannot be proven. This is correct, and it will be common.
- **Some `unprovable`.** Where the provider offers no authoritative read. Also
  correct, also honest.
- **`pending` that resolves on its own.** Eventual consistency. Nyst waits
  rather than guessing.
- **Held actions.** Blast Radius doing its job.

None of these are failures. A control plane that never says "I don't know" is
not being careful — it is guessing and not telling you.

Read [known boundaries](known-boundaries.md) before you rely on Nyst for
anything that matters.
