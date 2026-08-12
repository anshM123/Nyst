/**
 * Verify a restored Nyst database.
 *
 *   DATABASE_URL=postgres://…/restored \
 *   OUTCOME_SIGNING_KEY_ID=… OUTCOME_SIGNING_PRIVATE_KEY_B64=… \
 *   node --experimental-strip-types scripts/verifyRestore.ts
 *
 * A backup you have never restored is not a backup, and a restore you have
 * never verified is not a restore. This prints a fingerprint of everything a
 * Nyst deployment must still be able to do afterwards, reading through the
 * real product surfaces rather than by inspecting tables:
 *
 *   login · agents · policy binding · rollout mode · actions · evidence ·
 *   current resolution · signed receipt (signature RE-VERIFIED) ·
 *   event history · worker state · webhook identity
 *
 * Run it against the source database and against the restored one, and diff
 * the two outputs. Anything that differs is something the restore lost.
 *
 * The receipt signature check is the one that matters most. It passes only if
 * the signing identity persisted: a receipt signed by a key that was generated
 * at boot and thrown away cannot be verified by anyone, ever, which makes it
 * proof of nothing.
 */
import { Ed25519Signer } from "../dist/src/core/signing.js";
import { verifyResolution } from "../dist/src/engine/resolver.js";
import { ProductRepository } from "../dist/src/product/productRepository.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }

const organization = process.env.NYST_VERIFY_ORGANIZATION ?? "northwind";
const email = process.env.NYST_VERIFY_EMAIL ?? "ops@northwind.test";
const password = process.env.NYST_VERIFY_PASSWORD;
if (!password) {
  console.error("NYST_VERIFY_PASSWORD is required. It is read from the environment and never printed.");
  process.exit(1);
}

const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: url });
const repository = new ProductRepository(pool);

const signer = process.env.OUTCOME_SIGNING_KEY_ID && process.env.OUTCOME_SIGNING_PRIVATE_KEY_B64
  ? Ed25519Signer.fromEnv()
  : null;

const failures: string[] = [];
const count = async (table: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*)::int c FROM ${table}`)).rows[0]?.c ?? 0);

try {
  // Authentication through the real login path, not by reading a table.
  const session = await repository.login(organization, email, password);
  if (!session) throw new Error(`login failed for ${email} in ${organization}`);
  const principal = await repository.authenticateSession(session.session);
  if (!principal) throw new Error("the issued session did not authenticate");

  const agents = await repository.agents(principal);
  const actions = await repository.listActions(principal, { limit: 200 });
  const policies = await repository.policyHistory(principal);
  const environment = await repository.environmentControl(principal);

  // A deterministic choice, so two databases produce comparable output.
  const target = [...actions].sort((a, b) => String(a.action_id).localeCompare(String(b.action_id)))[0];
  if (!target) throw new Error("no actions survived the restore");
  const actionId = String(target.action_id);

  const evidence = await repository.evidence(principal, actionId);
  const resolutions = await repository.resolutions(principal, actionId);
  const receipt = await repository.receipt(principal, actionId);
  if (!receipt) failures.push("the signed receipt is missing");

  let signatureValid: boolean | null = null;
  if (receipt && signer) {
    signatureValid = verifyResolution(signer, receipt as never);
    if (!signatureValid) failures.push("the receipt signature did NOT verify after restore");
  } else if (receipt) {
    failures.push("no signing identity was supplied, so the receipt signature could not be checked");
  }

  const heartbeats = (await pool.query(
    `SELECT worker_kind FROM nyst_worker_heartbeats ORDER BY worker_kind`)).rows.map((row) => String(row.worker_kind));
  const webhooks = (await pool.query(
    `SELECT target_url, signing_secret_ref FROM nyst_webhook_endpoints ORDER BY target_url`)).rows;

  // A stored webhook secret would be a leak. Only the REFERENCE is durable.
  for (const hook of webhooks) {
    const reference = String(hook.signing_secret_ref ?? "");
    if (!/^(?:env|vault|secret-manager):/.test(reference)) {
      failures.push(`webhook ${String(hook.target_url)} stores something that is not an opaque reference`);
    }
  }

  const fingerprint = {
    login: "ok",
    organization: organization,
    agents: agents.map((agent) => String(agent.slug)).sort(),
    rollout_mode: environment.mode,
    policy_versions: policies.length,
    actions: actions.length,
    sample_action: actionId,
    sample_effect_state: target.effect_state ?? null,
    sample_directive: target.primary_directive ?? null,
    sample_evidence: evidence.length,
    sample_resolutions: resolutions.length,
    receipt_present: receipt !== null,
    receipt_signature_valid: signatureValid,
    resolution_transitions: await count("nyst_resolution_transitions"),
    intervention_events: await count("nyst_intervention_events"),
    consequence_admissions: await count("nyst_consequence_admissions"),
    shadow_evaluations: await count("nyst_shadow_evaluations"),
    worker_kinds_with_state: heartbeats,
    webhook_endpoints: webhooks.map((hook) => String(hook.target_url)),
    migrations_applied: await count("outcome_migrations"),
  };

  console.log(JSON.stringify(fingerprint, null, 2));
  await repository.deleteSession(session.session);
} finally {
  await pool.end();
}

if (failures.length) {
  console.error(`\nRESTORE VERIFICATION FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nRESTORE VERIFICATION PASSED");
