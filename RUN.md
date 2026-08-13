# Running Nyst v0.3.0

This page gets Nyst running on your machine and signs you in. Fifteen minutes,
no prior knowledge of the codebase.

For what Nyst *is*, read [README.md](README.md). For what was and was not
actually verified, read [VERIFICATION.md](VERIFICATION.md).

---

## What you need

| | |
| --- | --- |
| **Node** | 22 or newer (`node --version`) |
| **PostgreSQL** | 14 or newer, running and reachable |

Nothing else. Four runtime dependencies, and no build step you run by hand.

---

## 1. Install

```bash
npm ci
```

## 2. Create two databases

One for running Nyst, one for the tests. **Use separate databases** — the test
suite creates and destroys a lot of data, and the first start only bootstraps
your admin account into an *empty* database.

```bash
createdb nyst
```

```bash
createdb nyst_test
```

## 3. Apply the schema

**Both databases need it.** `npm run migrate` only touches the one
`DATABASE_URL` points at, so run it twice.

**macOS / Linux**

```bash
export DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst'
npm run migrate
```

```bash
DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst_test' npm run migrate
```

**Windows PowerShell**

```powershell
$env:DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst'
npm run migrate
```

```powershell
$env:DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst_test'; npm run migrate
$env:DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst'
```

You should see **24 migrations** apply and `migrations complete`, each time.

## 4. Start Nyst

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

Wait for `service_started` in the output. The first start compiles TypeScript,
so it takes about twenty seconds.

## 5. Look around

Open **<http://127.0.0.1:4080>**.

Signed out, that address is the **public site**. Signed in, it is your
dashboard. Both live on the same origin.

### Sign in

| Field | Value |
| --- | --- |
| Organization | `acme` — the **slug**, not the display name |
| Email | `you@acme.test` |
| Password | whatever you set above |

> The organization slug catches most people the first time. It is the short
> lowercase one.

Two of those variables are development-only, and Nyst **refuses to start with
them under `NODE_ENV=production`**: an ephemeral signing key cannot verify
yesterday's receipts, and a fake provider must never stand in for a real one.

---

## What to look at, in order

### The public site — no sign-in needed

| Page | What it is |
| --- | --- |
| <http://127.0.0.1:4080/> | The opening, and the thirteen-scene causal story. **Scene eight is the one to read.** |
| `/pricing` | Four plans, and a section on what your plan does *not* change |
| `/configure` | The deployment configurator. It ends by telling you what Nyst would **not** be covering |
| `/security` | What Nyst holds, and what it refuses to |
| `/contact` | Works with no session, no signup and no JavaScript |

### The product — signed in

| Page | What it is |
| --- | --- |
| `/outcomes` | **Start here.** What became true in the world |
| `/shadow` | Outcome Shadow: the gap between what your Agents believe and what is true |
| `/failure-lab` | Break something on purpose and watch what Nyst concludes |
| `/autonomy` | The Autonomy Line — an envelope, not a trust score |
| `/needs-attention` | Everything Nyst stopped on |
| `/protection` | What is actually protected, and what is only configured |

### Seeing the headline for yourself

The fastest route to the thing this release is about:

1. Go to **`/failure-lab`**.
2. Under **Outcome failures**, run **"Direct access removed, inherited access
   remains"**.
3. Nyst reports the action as fine and the **outcome as UNSATISFIED**, naming
   the exact invariant that is false and what it actually observed.

That verdict is computed by the same evaluator that runs in production. It is
not a scripted demo response — a test re-derives it from its own invariant
results, so a canned answer would fail the build.

---

## Running the tests

Against the **test** database, not the one you just started Nyst on:

**macOS / Linux**

```bash
DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst_test' npm test
```

**Windows PowerShell**

```powershell
$env:DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/nyst_test'; npm test
```

Expect **851 passing, 0 failing, 0 skipped**, in about 45 seconds.

If you see a large number of failures immediately, the test database almost
certainly has no schema — run `npm run migrate` against it first (step 3).

---

## If something goes wrong

**`DATABASE_URL is required`**
Nyst will not guess a connection string. Set it in the same shell you run the
command in.

**Sign-in fails with a correct password**
Two likely causes. Either you typed the organization *name* instead of the
*slug*, or the database already had data when Nyst first started — bootstrap
only runs against an empty database, so if you pointed Nyst at the database you
ran the tests on, no admin user was created. Use a fresh database.

**`migrations complete (0 applied, 24 already present)`**
The schema is already there. That is fine.

**Hundreds of test failures at once**
The test database has no schema. `npm run migrate` applies it to whichever
database `DATABASE_URL` names, and the tests use a different one from the
server — so it needs migrating too.

**Port 4080 is in use**
Set `NYST_PORT` to something else.

---

## Option B: Docker

Runs PostgreSQL, the API and the background workers together.

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `POSTGRES_PASSWORD`, `NYST_PUBLIC_ORIGIN`, and a signing
identity. Then:

```bash
docker compose run --rm migrate
```

```bash
docker compose up -d
```

Generate a signing identity with:

```bash
node --experimental-strip-types scripts/genkeys.ts
```

> **Not verified here.** Docker was not available on the machine this release
> was built on, so the image itself has never been built. The build *context*
> and the production dependency closure were verified — see
> [VERIFICATION.md](VERIFICATION.md). **Option A is the path that has actually
> been run end to end**, including a clean-room extract, install, migrate,
> full test run, start and sign-in.
