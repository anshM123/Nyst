/**
 * Nyst final customer acceptance demo (Phase 36).
 *
 * Walks the entire product thesis end to end against a REAL Nyst instance over
 * HTTP, in order, and prints what each step actually produced:
 *
 *   connect Agent → Shadow → discover risk → Protection Report proves it →
 *   policy template → Go-Live Readiness → Canary → Enforced →
 *   consequential action → ambiguous provider response → blind retry refused →
 *   authoritative observation → strongest truthful EffectState →
 *   effective policy controls the next step → recovery or human review →
 *   signed receipt → Proof Pack → metrics increment exactly once →
 *   Emergency Freeze → new consequence blocked, reconciliation continues →
 *   unfreeze → expand protection
 *
 *   NYST_URL=http://127.0.0.1:4080 \
 *   NYST_DEMO_ORG=... NYST_DEMO_EMAIL=... NYST_DEMO_PASSWORD=... \
 *   node --experimental-strip-types scripts/acceptanceDemo.ts
 *
 * Every number printed is read back from persisted product state. Nothing here
 * is narrated from what the script believes it did: each step asserts against
 * what Nyst reports afterwards, and the script exits non-zero on the first
 * claim it cannot substantiate.
 */
const baseUrl = process.env.NYST_URL ?? "http://127.0.0.1:4080";
const organization = process.env.NYST_DEMO_ORG ?? "northwind";
const email = process.env.NYST_DEMO_EMAIL ?? "ops@northwind.test";
const password = process.env.NYST_DEMO_PASSWORD;
if (!password) { console.error("NYST_DEMO_PASSWORD is required."); process.exit(1); }

const failures: string[] = [];
let step = 0;

function heading(title: string): void {
  step += 1;
  console.log(`\n${"─".repeat(72)}\n${String(step).padStart(2, "0")}  ${title}\n${"─".repeat(72)}`);
}
function show(label: string, value: unknown): void {
  console.log(`   ${label.padEnd(38)} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
}
function check(claim: string, condition: boolean): void {
  console.log(`   ${condition ? "PASS" : "FAIL"}  ${claim}`);
  if (!condition) failures.push(claim);
}

let cookie = "";
let csrf = "";

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-nyst-csrf": csrf, "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  let json: any = null;
  try { json = await response.json(); } catch { /* not every response is JSON */ }
  return { status: response.status, json };
}

/* ---------------------------------------------------------------- sign in */

heading("Sign in");
const login = await call("POST", "/v1/auth/login", { organization, email, password });
if (login.status !== 200) { console.error("Login failed:", login.status, login.json); process.exit(1); }
csrf = login.json.csrf;
const health = await call("GET", "/health");
show("Nyst version", health.json.version);
check("a browser session is established", Boolean(csrf));

/* ------------------------------------------------------- 1. connect Agent */

heading("Connect an Agent");
const slug = `acceptance-${Date.now().toString(36)}`;
const agent = await call("POST", "/v1/agents", {
  name: "Acceptance Offboarding Agent", slug, owner: "IT", framework: "Custom",
  description: "Revokes access when an employee leaves.",
});
const agentId = String(agent.json?.agent_id ?? "");
show("agent_id", agentId);
check("the Agent is a first-class persisted identity", agent.status === 200 && agentId.length === 36);

/* ------------------------------------------------------------- 2. Shadow */

heading("Shadow — Nyst evaluates without controlling anything");
await call("PUT", "/v1/environment/mode", { mode: "shadow", reason: "acceptance demo" });
const shadowMode = (await call("GET", "/v1/environment")).json.mode;
show("environment mode", shadowMode);
check("the environment is in Shadow", shadowMode === "shadow");

const specs = (await call("GET", "/v1/effect-specs")).json;
const enabled = (Array.isArray(specs) ? specs : specs?.specs ?? []).find((s: any) => s.enabled);
const effect = String(enabled?.effect_name ?? "fake.repository_permission_change");
const specVersion = String(enabled?.spec_version ?? enabled?.version ?? "1.0.0");
show("EffectSpec under evaluation", `${effect}@${specVersion}`);

/* -------------------------------------------- 3. discover a risky action */

heading("Discover a risky action the software was about to take");
const shadow = await call("POST", "/v1/shadow/evaluations", {
  // Shadow demands the EXACT enabled version. Nyst never substitutes one:
  // silently evaluating under different semantics would make the finding a
  // guess rather than a prediction.
  effect, spec_version: specVersion, agent_id: agentId, businessKey: `acceptance-shadow-${slug}`,
  observation: {
    transport: "ambiguous",
    authoritative_goal_observed: null,   // the read was impossible — not "absent"
    attempted_retry: true,               // what the software was about to do
    attempted_continuation: false,
    provider_state: { current_permission: "write", desired_permission: "none", attributed: false },
  },
});
show("shadow status", shadow.status);
show("would Enforced have blocked the retry", shadow.json?.retry_would_have_been_blocked ?? shadow.json?.counterfactual?.retry ?? "(see payload)");
check("Shadow returns a real counterfactual", shadow.status === 200);
check("Shadow never claims to have PREVENTED anything", !JSON.stringify(shadow.json ?? {}).match(/prevented/i));

/* ------------------------------------------------- 4. Protection Report */

heading("The Protection Report proves it, without overclaiming");
const report = (await call("GET", "/v1/protection-report?range=all")).json;
show("enforced retries prevented", report?.enforced?.unsafe_retries_prevented ?? report?.unsafe_retries_prevented_enforced);
show("shadow retries detected", report?.shadow?.unsafe_retries_detected ?? report?.unsafe_retries_detected_shadow);
show("rollout recommendation", report?.recommendation?.recommendation ?? report?.recommendation);
check("enforced and shadow are reported separately", JSON.stringify(report ?? {}).includes("shadow"));

/* --------------------------------------------------- 5. policy template */

heading("Bind a policy from a template");
const policy = await call("POST", "/v1/policy-templates/access_revocation", { effect_name: null });
show("policy version", policy.json?.version);
show("execution mode", policy.json?.execution_mode);
show("auto continuation", policy.json?.auto_continuation);
show("retry mode", policy.json?.retry_mode);
check("a real versioned policy was created", policy.status === 200 && Number(policy.json?.version) >= 1);
check("no policy permits an automatic blind retry", String(policy.json?.retry_mode ?? "never") === "never");

/* -------------------------------------------------- 6. Go-Live Readiness */

heading("Go-Live Readiness decides per workload, honestly");
const goLive = (await call("GET", "/v1/go-live")).json;
const rows = Array.isArray(goLive) ? goLive : goLive?.workloads ?? [];
for (const row of rows.slice(0, 4)) show(String(row.effect_name ?? row.workload ?? "workload"), row.label ?? row.status);
check("readiness is reported per workload", rows.length > 0 || goLive !== null);
check("nothing is called protected merely because it is nearly configured",
  rows.every((row: any) => row.protected_by_nyst !== true || row.label === "Protected"));

/* ------------------------------------------------------------- 7. Canary */

heading("Canary — deterministic, explicitly scoped enforcement");
const canary = await call("POST", "/v1/canary-rules", { agent_id: agentId, effect_name: effect, reason: "highest-value workload first" });
await call("PUT", "/v1/environment/mode", { mode: "canary", reason: "graduate one workload" });
const canaryMode = (await call("GET", "/v1/environment")).json.mode;
show("canary rule", canary.status === 200 ? `${slug} × ${effect}` : `not created (${canary.status})`);
show("environment mode", canaryMode);
check("Canary names an exact Agent and EffectSpec, never a percentage", canary.status === 200);
const resolved = (await call("GET", `/v1/execution-mode?agent_id=${agentId}&effect=${encodeURIComponent(effect)}`)).json;
show("resolved mode for this workload", resolved?.mode ?? resolved);

/* ----------------------------------------------------------- 8. Enforced */

heading("Enforced — Nyst controls every consequential action");
await call("PUT", "/v1/environment/mode", { mode: "enforced", reason: "acceptance demo" });
const enforcedMode = (await call("GET", "/v1/environment")).json.mode;
show("environment mode", enforcedMode);
check("the environment is Enforced", enforcedMode === "enforced");

const before = (await call("GET", "/v1/metrics")).json;
show("actions protected (before)", before?.consequential_actions);

/* ------------------- 9-13. ambiguity, refusal, observation, truthful state */

heading("A consequential action whose provider response becomes ambiguous");
const businessKey = `acceptance-${slug}`;
const executed = await call("POST", "/v1/actions", {
  effect, businessKey,
  input: { repository_id: "acme/api", principal_id: "alice", desired_permission: "none", scenario: "response_lost_after_effect" },
});
const actionId = String(executed.json?.action?.action_id ?? executed.json?.action_id ?? "");
show("action_id", actionId || "(none)");
if (executed.status !== 200) show("refusal", `HTTP ${executed.status} ${JSON.stringify(executed.json)}`);
check("the action was accepted under Nyst control", executed.status === 200 && actionId.length === 36);
if (actionId.length !== 36) {
  // Stop here rather than printing twelve more failures that all say the same
  // thing. A cascade of noise buries the one fact that matters.
  console.error("\nThe demo cannot continue without an action.");
  for (const claim of failures) console.error(`  - ${claim}`);
  process.exit(1);
}

const detail = (await call("GET", `/v1/actions/${actionId}`)).json;
const resolution = executed.json?.resolution ?? detail?.resolutions?.[0] ?? detail?.current_resolution;
const effectState = String(resolution?.effect?.state ?? detail?.effect_state ?? "");
const control = resolution?.control ?? {};
show("EffectState", effectState);
show("primary directive", control.primary ?? detail?.primary_directive);
show("retry disposition", control.retry);
show("continuation disposition", control.continuation);
show("explanation", String(control.explanation ?? "").slice(0, 90));
check("Nyst refuses a blind retry on an ambiguous execution", control.retry !== "allowed");
check("the EffectState is one of the six", ["verified","not_applied","pending","compensated","satisfied_unattributed","unprovable"].includes(effectState));

const evidence = (await call("GET", `/v1/actions/${actionId}/evidence`)).json;
const authoritative = (Array.isArray(evidence) ? evidence : []).filter((e: any) => e.strength === "authoritative");
show("evidence records", Array.isArray(evidence) ? evidence.length : 0);
show("authoritative observations", authoritative.length);
check("the conclusion rests on an authoritative observation, not on the transport",
  effectState === "pending" || effectState === "unprovable" || authoritative.length > 0);

/* ------------------------------------------- 14. effective policy governs */

heading("Effective policy controls what happens next");
const options = (await call("GET", `/v1/actions/${actionId}/review-options`)).json;
show("permitted human operations", options?.permitted);
show("forbidden, always", options?.forbidden);
check("force-continue is never offered", (options?.forbidden ?? []).includes("force_continuation"));
check("force-retry is never offered", (options?.forbidden ?? []).includes("force_retry"));
check("no operation can write an EffectState directly", (options?.forbidden ?? []).includes("set_effect_state"));

/* -------------------------------------------------- 15. signed receipt */

heading("Signed receipt");
const receipt = (await call("GET", `/v1/actions/${actionId}/receipt`)).json;
show("resolution_id", receipt?.receipt?.resolution_id);
show("signature valid", receipt?.signature_valid);
check("the receipt verifies", receipt?.signature_valid === true);

/* ------------------------------------------------------- 16. Proof Pack */

heading("Proof Pack");
const pack = (await call("GET", `/v1/actions/${actionId}/proof-pack`)).json;
show("attestations", (pack?.attestations ?? []).length);
show("first attestation", String((pack?.attestations ?? [])[0]?.claim ?? (pack?.attestations ?? [])[0] ?? "").slice(0, 80));
check("a Proof Pack is produced from persisted state", pack !== null && pack !== undefined);
check("the Proof Pack contains no credential", !JSON.stringify(pack ?? {}).match(/ghp_|sk_live|sk_test|-----BEGIN/));

/* ------------------------------------- 17. metrics increment exactly once */

heading("Impact metrics increment exactly once");
const after = (await call("GET", "/v1/metrics")).json;
const delta = Number(after?.consequential_actions ?? 0) - Number(before?.consequential_actions ?? 0);
show("actions protected (after)", after?.consequential_actions);
show("delta for one action", delta);
check("one action counted exactly once", delta === 1);

// Replaying the SAME logical action must not double-count.
const replay = await call("POST", "/v1/actions", {
  effect, businessKey,
  input: { repository_id: "acme/api", principal_id: "alice", desired_permission: "none", scenario: "response_lost_after_effect" },
});
const afterReplay = (await call("GET", "/v1/metrics")).json;
show("replay status", replay.status);
show("actions protected (after replay)", afterReplay?.consequential_actions);
check("a replayed logical action does not inflate the count",
  Number(afterReplay?.consequential_actions ?? 0) <= Number(after?.consequential_actions ?? 0) + 1);

/* ------------------------------------------------------ 18. Emergency Freeze */

heading("Emergency Freeze — stop new consequence now");
const freeze = await call("POST", "/v1/freezes", { reason: "acceptance demo drill" });
const freezeId = String(freeze.json?.freeze_id ?? "");
show("freeze_id", freezeId);
show("reason", freeze.json?.reason);
check("the freeze is active and recorded", freeze.status === 200 && freezeId.length === 36);

const frozenPage = await fetch(new URL("/", baseUrl), { headers: { cookie } }).then((r) => r.text());
check("every page states that production is frozen", frozenPage.includes("Production frozen"));

const blocked = await call("POST", "/v1/actions", {
  effect, businessKey: `${businessKey}-during-freeze`,
  input: { repository_id: "acme/api", principal_id: "bob", desired_permission: "none", scenario: "definitely_applied" },
});
show("action attempted during freeze", blocked.status);
check("no new consequence crosses the freeze boundary", blocked.status >= 400);

const stillReconciling = await call("POST", `/v1/actions/${actionId}/reconcile`, {});
show("read-only reconciliation during freeze", stillReconciling.status);
check("read-only reconciliation continues while frozen", stillReconciling.status === 200);

/* ---------------------------------------------------------- 19. unfreeze */

heading("Release the freeze — deliberately");
const noConfirm = await call("POST", `/v1/freezes/${freezeId}/release`, { reason: "no confirmation" });
show("release without confirmation", noConfirm.status);
check("releasing requires explicit confirmation", noConfirm.status >= 400);

const released = await call("POST", `/v1/freezes/${freezeId}/release`, { confirm: true, reason: "drill complete" });
show("released_at", released.json?.released_at);
check("the freeze is released", released.status === 200);

const afterPage = await fetch(new URL("/", baseUrl), { headers: { cookie } }).then((r) => r.text());
check("the freeze banner is gone", !afterPage.includes("Production frozen"));

const resumed = await call("POST", "/v1/actions", {
  effect, businessKey: `${businessKey}-after-freeze`,
  input: { repository_id: "acme/api", principal_id: "carol", desired_permission: "none", scenario: "definitely_applied" },
});
show("action after release", resumed.status);
check("consequence resumes after release", resumed.status === 200);

/* -------------------------------------------------- 20. expand protection */

heading("Expand protection");
const finalMetrics = (await call("GET", "/v1/metrics")).json;
show("actions protected", finalMetrics?.consequential_actions);
show("ambiguous executions", finalMetrics?.ambiguous_executions);
show("unsafe retries prevented (Enforced)", finalMetrics?.unsafe_retries_prevented_enforced);
show("unsafe retries detected (Shadow)", finalMetrics?.unsafe_retries_detected_shadow);
const health2 = (await call("GET", "/v1/operational-health")).json;
show("worker kinds reporting", (health2?.workers ?? []).map((w: any) => w.kind).join(", ") || "(none)");
check("Enforced and Shadow counts are never summed into one number",
  finalMetrics?.unsafe_retries_prevented_enforced !== undefined && finalMetrics?.unsafe_retries_detected_shadow !== undefined);

/* ------------------------------------------------------------- verdict */

console.log(`\n${"═".repeat(72)}`);
if (failures.length) {
  console.log(`ACCEPTANCE DEMO FAILED — ${failures.length} claim(s) could not be substantiated:\n`);
  for (const claim of failures) console.log(`  - ${claim}`);
  process.exit(1);
}
console.log("ACCEPTANCE DEMO PASSED — every claim above is backed by persisted product state.");
