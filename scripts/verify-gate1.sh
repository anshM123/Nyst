#!/usr/bin/env sh
# Gate 1 verification: run EVERYTHING, including the live PostgreSQL suite.
# Requires: Docker (with compose), Node 22+, network access for `npm install`.
#
#   ./scripts/verify-gate1.sh
#
# The PG integration suite FAILS (never silently skips) once DATABASE_URL is
# set — a broken schema, missing pg package, or unreachable server is a
# failure, which is the point.
set -eu
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://outcome:outcome@localhost:5432/outcome}"

echo "==> starting PostgreSQL via docker compose"
docker compose up -d --wait

echo "==> installing dependencies (pg + @types/node)"
npm install
npm install pg

echo "==> applying migrations"
npm run migrate

echo "==> typecheck"
npm run typecheck

echo "==> full test suite (unit + live PostgreSQL integration)"
npm test

echo ""
echo "GATE 1 VERIFICATION PASSED: typecheck, unit suite, and live PostgreSQL"
echo "integration (uniqueness under concurrency, append-only triggers on"
echo "evidence AND resolutions, same-action supersedes FK, dispatch-plan"
echo "constraint, full engine pipeline) all green."
