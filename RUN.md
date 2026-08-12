# Running Nyst v0.2.2

Start here. This page gets Nyst running on your machine and signs you in.
Fifteen minutes, no prior knowledge of the codebase.

For what Nyst *is* and why it exists, read [README.md](README.md).

---

## What you need

| | |
| --- | --- |
| **Node** | 22 or newer (`node --version`) |
| **PostgreSQL** | 14 or newer, running and reachable |

Nothing else. Nyst has three runtime dependencies and no build step you have to
run by hand.

If you would rather not install PostgreSQL, skip to
[Option B: Docker](#option-b-docker) — it runs the database, the API and the
workers for you.

---

## Option A: run it locally (recommended for a first look)

### 1. Install

```bash
npm ci
```

### 2. Create a database

Any empty PostgreSQL database will do.

```bash
createdb nyst
```

### 3. Apply the schema

**macOS / Linux**

```bash
export DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst'
npm run migrate
```

**Windows PowerShell**

```powershell
$env:DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst'
npm run migrate
```

You should see 17 migrations apply and `migrations complete`.

### 4. Start Nyst

The first start also creates your organization and admin user.

**macOS / Linux**

```bash
export NYST_LOCAL_EPHEMERAL_SIGNING=true
export NYST_ENABLE_DEVELOPMENT_FAKE=true
export NYST_BOOTSTRAP_ORGANIZATION='Acme'      NYST_BOOTSTRAP_ORG_SLUG=acme
export NYST_BOOTSTRAP_PROJECT='Platform'       NYST_BOOTSTRAP_PROJECT_SLUG=platform
export NYST_BOOTSTRAP_ENVIRONMENT='Production' NYST_BOOTSTRAP_ENV_SLUG=production
export NYST_BOOTSTRAP_EMAIL='you@acme.test'    NYST_BOOTSTRAP_DISPLAY_NAME='You'
export NYST_BOOTSTRAP_PASSWORD='pick something long'
npm run start:product
```

**Windows PowerShell**

```powershell
$env:NYST_LOCAL_EPHEMERAL_SIGNING='true'
$env:NYST_ENABLE_DEVELOPMENT_FAKE='true'
$env:NYST_BOOTSTRAP_ORGANIZATION='Acme';      $env:NYST_BOOTSTRAP_ORG_SLUG='acme'
$env:NYST_BOOTSTRAP_PROJECT='Platform';       $env:NYST_BOOTSTRAP_PROJECT_SLUG='platform'
$env:NYST_BOOTSTRAP_ENVIRONMENT='Production'; $env:NYST_BOOTSTRAP_ENV_SLUG='production'
$env:NYST_BOOTSTRAP_EMAIL='you@acme.test';    $env:NYST_BOOTSTRAP_DISPLAY_NAME='You'
$env:NYST_BOOTSTRAP_PASSWORD='pick something long'
npm run start:product
```

### 5. Sign in

Open **<http://127.0.0.1:4080>**.

| Field | Value |
| --- | --- |
| Organization | `acme` — the **slug**, not the display name |
| Email | `you@acme.test` |
| Password | whatever you set above |

The organization slug catches most people the first time. It is the third
field, and it is the short lowercase one.

Two of those variables are development-only and Nyst **refuses to start with
them under `NODE_ENV=production`**: an ephemeral signing key cannot verify
yesterday's receipts, and a fake provider must never stand in for a real one.

---

## Option B: Docker

Runs PostgreSQL, the API and the background workers together.

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `POSTGRES_PASSWORD`, `NYST_PUBLIC_ORIGIN`, and a signing
identity (see below). Then:

```bash
docker compose run --rm migrate
```

```bash
docker compose up -d
```

Nyst listens on `127.0.0.1:4080`.

Generate a signing identity with:

```bash
node --experimental-strip-types scripts/genkeys.ts
```

> **Not verified here.** Docker was not available on the machine this release
> was built and tested on, so the image itself has never been built. The build
> *context* was verified — see [VERIFICATION.md](VERIFICATION.md). Option A is
> the path that has actually been run end to end.

---

## Seeing it do something

An empty Nyst is honest but dull: it says "No consequential actions yet",
because there have not been any.

### Seed a realistic environment

```bash
node --experimental-strip-types scripts/seedDemo.ts
```

This creates an organization, two Agents, a policy, Shadow findings, a Canary
rule, five real controlled actions including genuine ambiguity, an open human
review, and a consequence budget.

Everything goes through the **real** product surfaces — the runtime, the
repository, the admission gate. Nothing is inserted into a metrics table, and
no outcome is hardcoded. Sign in with:

| Field | Value |
| --- | --- |
| Organization | `northwind` |
| Email | `ops@northwind.test` |
| Password | `Nyst design partner demo 2026!` |

### Watch the whole thesis run

```bash
node --experimental-strip-types scripts/acceptanceDemo.ts
```

Set `NYST_DEMO_PASSWORD` first. It drives the complete loop over HTTP — connect
an Agent, Shadow, Protection Report, policy, Canary, Enforced, an ambiguous
action, refused retry, authoritative observation, signed receipt, Proof Pack,
Emergency Freeze, release — and **asserts every claim against what Nyst reports
back**, exiting non-zero on the first one it cannot substantiate.

### Break things on purpose

**Failure Lab** in the sidebar (available in Shadow or Demo environments) runs
seeded fault scenarios — response lost after the effect applied, transport
timeout, eventual consistency — through the real engine, and shows the
EffectState and ControlDecision each one produces.

It runs with a secret provider that resolves *nothing*, so a simulation is
structurally incapable of touching a real system.

---

## Running the tests

Use a **separate** database for tests:

```bash
createdb nyst_test
```

```bash
DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst_test' npm test
```

Expect **658 passing, 0 failing, 0 skipped**, in about 40 seconds.

The integration tests are real: they run against PostgreSQL and create their
own tenants. Pointing them at the database you signed in to is harmless to your
data, but it leaves test organizations behind — and first-boot bootstrap only
runs on an **empty** Nyst, so a database that has had the tests run against it
will not create your admin user. If your login is rejected on a database you
just created, this is almost certainly why.

```bash
npm run typecheck
```

---

## Where to look first

| | |
| --- | --- |
| **Overview** | Whether Nyst is evaluating, controlling or protecting — and it will not say "protecting" until it has actually prevented something |
| **Needs Attention** | Everything a person has to decide |
| **Actions** | Every consequential action, its EffectState, and the evidence behind it |
| **Protection** | Enforced and Shadow reported in separate columns, never summed |
| **Failure Lab** | Ambiguity on demand |

Click any action to see the current explanation with the evidence it cites, the
full resolution history, and the signed receipt.

---

## If something goes wrong

**"Those credentials were not accepted."**
Two likely causes. The Organization field wants the **slug** (`acme`), not the
display name. Or the database was not empty when Nyst first started — the
bootstrap admin user is created only on a genuinely fresh Nyst, so if you ran
`npm test` against this database first, drop it, recreate it, migrate, and
start again.

**Nyst will not start, and prints a list of problems.**
That is deliberate. Production startup fails closed rather than warning and
continuing, because a misconfigured Nyst accepts consequential actions and then
cannot resolve them. Each line says exactly what to change.

**`DATABASE_URL is required`**
It is not set in the shell you are actually running in. On Windows, `$env:VAR`
does not persist across separate terminal windows.

**Port 4080 is in use.**
Set `NYST_PORT` to something else.

**The Failure Lab shows no form.**
It is isolated to Shadow and Demo environments so a simulation can never be
mistaken for production protection. The page states the current mode. Switch
the environment to Shadow in **Settings**.

**Everything reads zero.**
There have been no consequential actions yet. Run the demo seed above.

---

## Read next

| | |
| --- | --- |
| [README.md](README.md) | What Nyst is, and how it differs from retry, idempotency and durable execution |
| [VERIFICATION.md](VERIFICATION.md) | What was verified for this release, and what was not |
| [docs/product/known-boundaries.md](docs/product/known-boundaries.md) | What Nyst does not do. Read before relying on it |
| [docs/product/design-partner-guide.md](docs/product/design-partner-guide.md) | The full path to a protected production workload |
| [SECURITY.md](SECURITY.md) | The security model, including its weaknesses |
