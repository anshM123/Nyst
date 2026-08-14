# Nyst

**Effect-control infrastructure for autonomous software.**

> Nyst is the safety control plane between autonomous software and the systems
> it changes. After a consequential action it determines what external effect
> actually happened — and decides what is safe to do next.

```text
INTENT → EXECUTION → OBSERVATION → RECONCILIATION → EFFECT STATE → CONTROL DECISION → SIGNED RECEIPT
```

**Version 0.3.1 — backend-hardened.**

> **Just want to run it?** → **[RUN.md](RUN.md)** (fifteen minutes)
> **Want to know what was actually verified?** → **[VERIFICATION.md](VERIFICATION.md)**
> **Want to know where Nyst stops?** → **[Known boundaries](docs/product/known-boundaries.md)**

## What is new in 0.3.1

A backend hardening pass. No redesign of the public site or the authenticated
application: the work was in persistence, concurrency, authentication and
deployment, so a frontend team can build against a substrate that behaves.

Nine defects, each reproduced by a failing test before it was fixed:

| # | Defect | Why it mattered |
|---|---|---|
| 1 | `POST /v1/world-facts` accepted `authoritative: true` | An Agent could manufacture the truth Nyst evaluates about it |
| 2 | `/signup` was linked six times and did not exist | And when built, it landed new accounts in **Enforced** |
| 3 | Google Sign-In had a verifier, a schema and 21 tests — and no route | Nothing was reachable; a disconnected account could never be reconnected |
| 4 | The contact form thanked people for messages it discarded | `record_contact` was never supplied anywhere |
| 5 | The quote configurator kept no record of any quote | A company that priced Nyst and left was invisible |
| 6 | Concurrent Outcome evaluation collided on its sequence | The optimistic guard ran *after* the statement that collided |
| 7 | A late-arriving older observation superseded a newer one | Nyst could report access removed while it was live |
| 8 | One Outcome Receipt per instance, forever | "Prove it is now satisfied" returned a signed *unsatisfied* statement |
| 9 | A person's identity was a permanent idempotency key | A rehired contractor could not be offboarded a second time |

Plus `/ready`, which answered "ready" for any process that could open a socket
to PostgreSQL — including one running against a schema three releases behind.

## What is new in 0.3.0

Three layers, kept deliberately separate, because collapsing them is where the
failure lives:

| Layer | Question | Values |
|---|---|---|
| **Authority** | What may this Agent do? | autonomous · human · disabled |
| **Effect** | What happened to this operation? | six EffectStates |
| **Outcome** | What became true in the world? | satisfied · unsatisfied · indeterminate |

The headline case, and the reason the outcome layer exists:

> The offboarding agent removed Alice's direct repository access. The action
> was **VERIFIED**. Alice is in a team that grants WRITE to the same
> repository.
>
> **ACTION VERIFIED. OUTCOME UNSATISFIED.**

Also new: a deterministic invariant engine with no LLM in the safety path, the
Autonomy Line (an envelope, never a trust score), signed Outcome Receipts and
ContinuationGrants, Outcome Shadow, Evidence Ingest, the customer-side Relay,
Failure Lab 2.0 and NystBench.

---

## The problem

Your agent calls an API to revoke a departing employee's production access.
The connection drops before the response arrives.

You now have three options and no information:

- **Retry.** If the first call landed, you may re-trigger a workflow, send a
  second notification, or double-apply something that was not idempotent.
- **Continue.** If the first call did not land, a former employee still has
  production access and your offboarding pipeline reports success.
- **Stop.** Safe, but everything downstream stalls and a person has to work
  out what happened by hand.

The exception told you the *call* failed. It told you nothing about the
*world*. Every one of those three options is a guess, and the guess is made
worst exactly when the action mattered most.

Nyst answers the question you actually have — *did the effect happen?* — and
then, separately, *what may I do now?*

### Why ambiguity is the dangerous case, not the rare one

Ambiguous outcomes concentrate where consequence concentrates: retries on slow
endpoints, timeouts on the heaviest operations, eventual consistency in exactly
the identity and permission systems you care most about. Autonomous software
makes it worse, because it acts continuously, at machine speed, and it will
happily retry a thousand times while a human would have stopped to check.

An agent that cannot tell "it failed" from "I don't know" will eventually
choose wrong on something that matters.

---

## How Nyst differs from things you already have

| | What it gives you | What it cannot tell you |
| --- | --- | --- |
| **Retry libraries** | Another attempt | Whether the previous attempt took effect |
| **Idempotency keys** | Deduplication *when the provider supports them, for the window it supports* | Anything about providers that do not, or about an effect applied by something other than you |
| **Durable execution / workflow engines** | Your *code* resumes exactly once | Whether the *external system* changed. A durably-executed HTTP call that timed out is still ambiguous |
| **Observability** | That something went wrong, after the fact | What to do next, at the moment you have to decide |
| **Nyst** | The external effect state, and an explicit control decision, with the evidence that produced it | It is not a guarantee. See [limitations](#limitations) |

The distinction that matters: those tools reason about **your execution**.
Nyst reasons about **the external world**, by going and looking at it.

---

## Two axes, never collapsed

Nyst reports **what it knows** and **what you may do** as separate answers.
Collapsing them is the mistake that makes ambiguity dangerous.

### Axis 1 — EffectState: what Nyst knows

Exactly six. The set is closed; there is no seventh.

| State | Meaning |
| --- | --- |
| `verified` | The intended effect occurred exactly as intended. |
| `not_applied` | Sufficient evidence that the effect did **not** occur. |
| `pending` | Resolution is still underway — for example provider eventual consistency. |
| `compensated` | The effect occurred undesirably and has been reversed. |
| `satisfied_unattributed` | The desired end state exists, but this action's causation is unproven. |
| `unprovable` | Nyst cannot determine what happened with sufficient evidence. |

### Axis 2 — ControlDecision: what your software may do next

A `primary` directive — `continue`, `retry`, `do_not_retry`, `hold`,
`compensate`, `escalate` — plus **independent** dispositions for `retry`,
`continuation` and `recovery`.

There is no global mapping from one axis to the other. The case that proves it:

> `satisfied_unattributed` → `primary: do_not_retry`, `retry: forbidden`,
> `continuation: allowed`
>
> The access is gone, so your offboarding may proceed. But you cannot prove
> *you* removed it, so re-sending is forbidden — a retry might apply a second,
> different change to a system someone else has already touched.

No local rule of thumb reproduces that. This is why the decision is made by
the control plane, which can see the evidence, and not by the caller.

### Ambiguity is an answer

`pending` with `hold` is Nyst working correctly, not failing. `unprovable` is
an honest report that the evidence does not support a conclusion. Nyst will
never upgrade "I don't know" into "it's fine" — the third invariant below
exists precisely to forbid that.

---

## Three non-negotiable invariants

1. One logical Nyst action must never cause duplicate external effects.
2. Nyst must never report more certainty than its evidence supports.
3. Nyst must never authorize an unsafe follow-up because transport or
   execution state was confused with actual external effect state.

A timeout is not proof of failure. HTTP 2xx is not proof of the intended
effect. Missing evidence is not proof of non-application. Ambiguity never
authorizes a blind retry.

There is no force-continue. Not in the API, not in the SDK, not in the
dashboard. An override that lets a caller declare an ambiguous action safe
would defeat the only thing Nyst does.

---

## Current EffectSpecs

An **EffectSpec** is the versioned, provider-specific definition of what an
effect means, what evidence is authoritative for it, and how that evidence maps
to an EffectState. Nyst ships four real ones:

| EffectSpec | What it controls | Authoritative evidence |
| --- | --- | --- |
| `github.repository_permission_change` | Repository collaborator permission | Repository permission read for the principal |
| `okta.user_suspension` | Okta user suspend / activate | User status read |
| `stripe.refund` | Exact full sandbox refund | Refund object match plus action attribution |
| `stripe.payment_capture` | Exact final full sandbox capture | Charge object match plus action attribution |

A fifth, `fake`, exists for development and the Failure Lab and is refused
outright under `NODE_ENV=production`.

See [EffectSpec semantics](docs/product/effectspec-semantics.md).

---

## Architecture

```text
                 ┌─────────────────────────────────────────────┐
   your agent ──▶│  Nyst web / API host   (scripts/startProduct)│
                 │  · admission · policy · dispatch · dashboard │
                 └───────────────┬─────────────────────────────┘
                                 │
                          PostgreSQL  ── the durable record: actions,
                                 │        evidence, resolutions, receipts,
                                 │        policy versions, audit
                                 │
                 ┌───────────────┴─────────────────────────────┐
                 │  Nyst workers          (scripts/startWorker) │
                 │  · reconciliation · recovery                 │
                 │  · re-observation  · webhook delivery        │
                 └───────────────┬─────────────────────────────┘
                                 │  read-only observation
                                 ▼
                    GitHub · Okta · Stripe
```

The workers run in **separate processes** from the API. An API that answers
while its workers are dead is the single most dangerous state a Nyst
deployment can be in, so worker liveness is a first-class, queryable signal
(`/v1/operational-health`) rather than an assumption.

More detail: [architecture](docs/architecture.md).

---

## Shadow → Canary → Enforced

You do not have to trust Nyst before you can measure it.

- **Shadow.** Your software keeps full control. You tell Nyst what you observed
  and what you were about to do; Nyst applies the *real* EffectSpec semantics
  and reports what Enforced Mode **would** have decided. It controls nothing,
  and the dashboard never says "prevented" in Shadow — only "detected".
- **Canary.** Deterministic, explicitly scoped enforcement: one Agent, one
  EffectSpec, one Environment. Never a percentage — "5% of your revocations"
  is not a safety property anyone can reason about.
- **Enforced.** Nyst controls every consequential action in the environment.

The same five primitives — identity, observation normalization, evidence
interpretation, EffectState derivation, ControlDecision — run in all three
modes. Only provider dispatch is Enforced-only. That is what makes a Shadow
finding a real prediction rather than a mock-up.

See [Shadow, Canary and Enforced](docs/product/rollout-modes.md).

---

## Quickstart (5–15 minutes)

Requires Node 22+ and PostgreSQL 14+.

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

Open <http://127.0.0.1:4080>, sign in with the organization slug, email and
password you just set, and issue an API key from **Settings**.

`NYST_LOCAL_EPHEMERAL_SIGNING` and `NYST_ENABLE_DEVELOPMENT_FAKE` are
development-only and are **rejected** under `NODE_ENV=production`.

### SDK

```bash
npm install @nyst-ai/sdk
```

```ts
import { NystClient, mayContinue, mayRetry, needsHuman } from "@nyst-ai/sdk";

const nyst = new NystClient({ baseUrl: process.env.NYST_URL!, apiKey: process.env.NYST_API_KEY! });

const { action_id, resolution } = await nyst.execute({
  effect: "github.repository_permission_change",
  businessKey: "offboard:alice@acme.com:acme/api",
  input: { repository_id: "acme/api", principal_id: "alice", desired_permission: "none" },
});

const { effect, control } = resolution;
console.log(effect.state, "→", control.primary, "—", control.explanation);

if (needsHuman(control))       await pageOncall(action_id, control.explanation);
else if (mayContinue(control)) await nextStep();
else if (mayRetry(control))    await retryOnce();
// otherwise: stop. Neither continuing nor retrying is permitted.
```

Read the dispositions; do not re-derive them. `retry: "unknown"` is **not**
permission — it is the explicit statement that permission could not be
established.

Full guide: [SDK quickstart](docs/product/quickstart.md) ·
[package README](packages/sdk/README.md).

---

## Failure Lab

Ambiguity is hard to rehearse, because you cannot ask a provider to lose your
response on demand. The Failure Lab runs deterministic, seeded fault scenarios
— response lost after the effect applied, transport timeout, eventual
consistency, definitely-not-sent — through the **real** engine and shows you
the EffectState and ControlDecision each one produces.

It cannot resolve a credential at all: it runs with a secret provider that
refuses everything, so a simulation is structurally incapable of touching a
real system rather than merely trusted not to.

Its results are labelled `SIMULATED` everywhere they appear and never
contribute to protection metrics.

---

## Security model

- **Tenancy.** Every row is scoped to organization / project / environment, and
  agent identity is bound by composite foreign key, so a cross-tenant agent is
  structurally impossible rather than filtered out at query time.
- **Credentials.** Nyst stores an *opaque reference* (`env:NYST_GITHUB_TOKEN`),
  never a secret value. A resolved secret must never reach the database,
  evidence, a receipt, a log, action input, a webhook, the browser, a metric,
  the Protection Report, or a Proof Pack. See [secrets](docs/product/secrets.md).
- **Receipts.** Ed25519 software signatures over the resolution document. This
  is **tamper evidence**, not hardware attestation — see below.
- **Browser.** Strict CSP (`script-src 'self'`, `style-src 'self'`,
  `frame-ancestors 'none'`), CSRF token on every mutating call, httpOnly
  session cookies, and no authoritative safety logic in client JavaScript.
- **Webhooks.** HMAC-signed, timestamped, replay-windowed, and delivered to a
  DNS-pinned address to prevent rebinding.

Details: [security and operations](docs/product/security-and-operations.md).

---

## Deployment

One image, three roles: web/API, workers, migrations.

```bash
docker compose run --rm migrate
docker compose up -d
```

Production startup **fails closed** on unsafe configuration — a missing
durable signing identity, a plaintext public origin, an insecure cookie
setting, a known development key, demo or fake providers left enabled, debug
credential logging. It refuses to boot rather than warning and continuing,
because a misconfigured Nyst is more dangerous than an absent one.

[Deployment guide](docs/product/deployment.md) ·
[design-partner deployment guide](docs/product/design-partner-guide.md) ·
[backup and restore](docs/product/backup-and-restore.md) ·
[upgrades and migrations](docs/product/upgrades.md).

---

## Limitations

Nyst is **not** "guaranteed safe", and this section is not a formality.

- **Nyst is only as good as the provider's observability.** If a provider
  offers no authoritative read for an effect, the honest answer is
  `unprovable`, and you will get it.
- **Four EffectSpecs.** Anything outside them is not controlled by Nyst.
- **Software signing only.** No HSM, no hardware attestation, no trusted
  timestamping. A receipt is tamper-*evident*, and is only as trustworthy as
  the machine holding the private key.
- **Single-region PostgreSQL.** No multi-region consistency story, no proven
  zero-downtime migration path — see [upgrades](docs/product/upgrades.md),
  which states plainly where a maintenance window is required.
- **At-least-once webhooks.** Deduplicate on `action_id` plus
  `resolution_version`.
- **Compensation is a directive, not a capability.** Nyst tells you when a
  compensation is required and records it; executing one requires a registered
  executor you opt into. With none registered, recovery is cancelled rather
  than performed — deliberately fail-safe.
- **Reconciliation costs provider calls.** Ambiguity is resolved by looking,
  and looking has a rate limit.

The complete list, including what each boundary means in practice:
[known boundaries](docs/product/known-boundaries.md).

---

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | The engine and the product control plane |
| `packages/sdk/` | The publishable `@nyst-ai/sdk` client |
| `db/migrations/` | Ordered, forward-only SQL migrations |
| `scripts/` | Web host, worker host, migrations, restore verification |
| `tests/` | `node --test`; PostgreSQL integration tests included |
| `docs/` | Everything linked from this page |

Some internal identifiers remain `Outcome*`-prefixed because the architecture
predates the Nyst name. They are retained deliberately to avoid
correctness-risking churn.

```bash
npm test
```
