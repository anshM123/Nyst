# Backup and restore

Everything Nyst knows lives in PostgreSQL. The processes are stateless; the
database is the product. There is exactly one thing to back up, and one thing
outside it you must not lose: the **signing private key**, which lives in your
secret store, not in the database.

A backup you have never restored is not a backup.

---

## What must survive

| | Why it matters |
| --- | --- |
| Users, organizations, projects, environments | Nobody can sign in without them |
| Agent registry | Actions are bound to agent identity by composite key |
| Policy versions | Immutable; an action's governing policy is part of its meaning |
| Rollout mode and Canary rules | What Nyst was controlling, and when |
| Actions, evidence, resolutions | The record of what happened |
| Signed receipts | Worthless if the signature stops verifying |
| Resolution transitions and intervention events | The audit trail |
| Consequence admissions | The blast-radius accounting ledger |
| Worker heartbeats and queue state | Operational continuity |
| Webhook endpoints and their secret **references** | Delivery identity. The secret itself is never stored |

---

## Backing up

```bash
pg_dump -h "$PGHOST" -U "$PGUSER" -d nyst -Fc -f "nyst-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Custom format (`-Fc`) so `pg_restore` can be used, which is what you will
actually want under pressure.

Notes:

- A dump taken while Nyst is running is consistent — `pg_dump` uses a single
  transaction snapshot. You do not need downtime to back up.
- The dump contains **no provider credentials and no signing key**. It contains
  opaque references to them. Restoring into an environment without those
  secrets gives you a Nyst that can read its history but cannot reach providers
  and cannot verify signatures — which is the correct behaviour, not a bug.
- Encrypt dumps at rest. They contain your full audit trail, session records,
  and API key hashes.
- **Never commit a dump to source control**, and never include one in a release
  archive.

---

## Restoring

Always restore into a **fresh, empty database**, never over a live one.

```bash
createdb nyst_restored
pg_restore -h "$PGHOST" -U "$PGUSER" -d nyst_restored --no-owner --no-privileges nyst-20260811T120000Z.dump
```

Then verify before you point anything at it:

```bash
DATABASE_URL='postgres://…/nyst_restored' \
OUTCOME_SIGNING_KEY_ID='…' OUTCOME_SIGNING_PRIVATE_KEY_B64='…' \
NYST_VERIFY_PASSWORD='…' \
node --experimental-strip-types scripts/verifyRestore.ts
```

`scripts/verifyRestore.ts` exercises the real product surfaces rather than
inspecting tables: it logs in through the authentication path, lists agents,
reads the rollout mode and policy binding, pulls an action with its evidence
and resolutions, **re-verifies the receipt signature**, counts the audit trail,
checks worker state, and asserts that every stored webhook secret is an opaque
reference rather than a value.

Run it against the source database too, and diff the two outputs. Anything that
differs is something the restore lost.

---

## The drill, performed

This procedure was executed locally against PostgreSQL 17.2 on 2026-08-11, not
merely written down.

1. Created a fresh database and applied **all 17 migrations from zero**.
2. Seeded through real product surfaces only — no direct inserts into metrics
   or state tables: an organization, project, environment and admin user; two
   Agents; a policy created from the access-revocation template; four Shadow
   evaluations; a Canary rule; five real controlled actions including genuine
   ambiguity; a human review; a blast-radius budget; a webhook endpoint.
3. Ran the real worker host until all four loops had recorded heartbeats.
4. `pg_dump -Fc` → 200,532 bytes.
5. Restored into a **different, freshly created database** with `pg_restore`
   (45 tables).
6. Ran `scripts/verifyRestore.ts` against both.

The two fingerprints were **identical**:

```json
{
  "login": "ok",
  "agents": ["deploy-bot", "hr-offboarding"],
  "rollout_mode": "canary",
  "policy_versions": 2,
  "actions": 5,
  "sample_effect_state": "pending",
  "sample_directive": "hold",
  "sample_evidence": 3,
  "sample_resolutions": 2,
  "receipt_present": true,
  "receipt_signature_valid": true,
  "resolution_transitions": 8,
  "intervention_events": 11,
  "consequence_admissions": 5,
  "shadow_evaluations": 4,
  "worker_kinds_with_state": ["reconciliation", "recovery", "reobservation", "webhook"],
  "webhook_endpoints": ["https://hooks.northwind.test/nyst"],
  "migrations_applied": 17
}
```

Nyst was then started against the restored database. `/health` and `/ready`
both answered, login over HTTP succeeded, all six checked dashboard pages
rendered, `/v1/actions/{id}/receipt` returned `signature_valid: true`, and
`/v1/operational-health` reported all four worker kinds.

The receipt signature verifying **in a different database, in a new process**
is the part that matters. It passes only because the signing identity was
supplied from the environment rather than generated at boot. An ephemeral
identity fails here, which is exactly why production refuses to use one.

---

## Restoring into production

1. **Stop the workers first**, then the web host. Workers hold leases; a worker
   still running against the old database while you promote a restored one will
   write into the past.
2. Restore into a fresh database.
3. Verify with `scripts/verifyRestore.ts`, including the signature check.
4. Repoint `DATABASE_URL`.
5. Start the web host, confirm `/ready`.
6. Start the workers, confirm `/v1/operational-health` shows all four kinds
   with recent heartbeats.

### What a restore cannot undo

A restore rewinds Nyst's *record*. It does not rewind the *world*. Effects that
were genuinely applied to GitHub, Okta or Stripe after the backup point are
still applied, and Nyst will now be unaware of them.

After restoring to an earlier point, expect Nyst to re-observe and reconcile
actions it has forgotten it completed. This is safe — reconciliation is
read-only, and an effect that is already present resolves to `verified` or
`satisfied_unattributed` rather than being re-applied — but it is not
instantaneous, and the Protection Report will show a gap.

If the restore point is significantly behind, consider an
[Emergency Freeze](freeze.md) before starting the workers, so no *new*
consequence is admitted while you reconcile the backlog.

---

## Retention

- Daily full dumps, retained per your compliance requirement.
- Test a restore on a schedule, not only after an incident. The command above
  exists so that test is one line.
- Back up the **signing public keys** with the same rigour as the database.
  Receipts signed by a key whose public half you no longer have are
  unverifiable forever.
