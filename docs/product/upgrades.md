# Upgrades and migrations

## What is claimed, and what is not

**Nyst does not claim zero-downtime migrations.** No zero-downtime upgrade path
has been proven for this product, and until one is proven with tests, saying
otherwise would be an unearned enterprise-sounding claim.

What is proven:

- All 17 migrations apply cleanly to an **empty** database, from zero, in
  order. This is verified in the clean-room check and again in the
  [backup and restore drill](backup-and-restore.md).
- Each migration runs inside its own transaction together with the ledger row
  recording it, so a migration that fails part-way leaves neither half-applied
  schema nor a false record of success.
- Migrations are forward-only and applied in filename order, tracked in
  `outcome_migrations`.

What is **not** proven:

- Rolling upgrades with old and new application versions running concurrently
  against the same schema.
- Downgrade or rollback of an applied migration. There are no `down` scripts.
- Migration timing on a large table. Every migration here has run against small
  datasets only.

---

## The supported upgrade procedure

Assume a short maintenance window. Assume you have a fresh backup.

```bash
# 1. Back up first. Not optional.
pg_dump -h "$PGHOST" -U "$PGUSER" -d nyst -Fc -f "pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

```bash
# 2. Stop the WORKERS first. They hold leases and write resolutions.
docker compose stop worker
```

```bash
# 3. Stop the web host. New consequential actions stop being accepted here.
docker compose stop web
```

```bash
# 4. Apply migrations with nothing else connected.
docker compose run --rm migrate
```

```bash
# 5. Start the web host, then confirm readiness.
docker compose up -d web
curl -fsS http://127.0.0.1:4080/ready
```

```bash
# 6. Start the workers, then confirm all four loops are alive.
docker compose up -d worker
curl -fsS http://127.0.0.1:4080/v1/operational-health   # requires an API key
```

### Why the workers stop first, and start last

A worker running old code against a new schema can write a resolution the new
code will not understand, and a worker mid-claim during a schema change is the
one place where Nyst's careful lease discipline has nothing to protect it. The
ordering is not ceremony.

### What happens to in-flight ambiguous actions

They are safe across the window. An ambiguous action lives in the database, not
in a process. When the workers come back:

- Expired leases are reclaimed, and the **dispatch boundary** — not the lease —
  decides whether re-dispatch is permitted.
- Reconciliation resumes read-only observation from where it left off.
- No consequential effect is re-applied because a process restarted.

A killed worker is a designed-for case, not an emergency. That is also why
`docker compose stop` (SIGTERM, graceful shutdown, finish the current tick) is
preferred over `kill -9`.

---

## Alternative: freeze instead of stopping the web host

If you would rather keep the dashboard readable during the window, activate an
[Emergency Freeze](freeze.md) instead of stopping the web host at step 3. No
new consequential action will be admitted, while existing ambiguous actions
continue safe read-only reconciliation and operators can still see state.

This does not remove the need to stop the workers before migrating.

---

## Rollback

There is no automated rollback, and this is a deliberate limitation rather than
an oversight.

If an upgrade fails:

1. Stop the workers and the web host.
2. Restore the pre-upgrade dump into a **fresh** database.
3. Verify it — including the receipt signature — with
   `scripts/verifyRestore.ts`.
4. Repoint `DATABASE_URL` at the restored database and start the old version.

Then read [what a restore cannot undo](backup-and-restore.md#what-a-restore-cannot-undo):
effects applied to real providers during the failed upgrade window are still
applied, and the restored Nyst will not know about them until it re-observes.

---

## Version compatibility

| | Policy |
| --- | --- |
| Database schema | Forward-only. A newer schema with an older app is unsupported |
| API (`/v1`) | Additive within a minor version |
| `@nyst-ai/sdk` | Tracks the server minor version. 0.2.x SDK against a 0.2.x server |
| EffectSpec versions | Immutable. A new version is a new version, never an edit |
| Policy versions | Immutable. A change creates a new version and records who made it |

---

## Before you upgrade a production deployment

- [ ] Fresh `pg_dump`, and a restore of it verified somewhere else.
- [ ] The new version's migrations reviewed — `db/migrations/`, in order.
- [ ] A maintenance window agreed, or a Freeze planned.
- [ ] The signing identity unchanged, or a
      [rotation](receipt-signing.md#rotation) planned separately. Do not rotate
      keys and upgrade in the same window.
- [ ] Someone watching `/v1/operational-health` afterwards. An API that answers
      while its workers are dead is the most dangerous state a Nyst deployment
      can be in, and it looks perfectly healthy from the outside.
