/**
 * Nyst v0.3.2 — Phase 1. THE AUTHORITY LAYER MUST ACTUALLY GATE CONSEQUENCES.
 *
 * THE DEFECT, AND IT IS THE MOST SERIOUS ONE IN THIS PROJECT.
 *
 * `evaluateAuthority()` has ZERO production call sites. Not one. It is a
 * complete, correct, well-tested eight-constraint evaluator that nothing in the
 * request path ever calls. `evaluateAutonomyLine()` has exactly one caller —
 * `evaluateAuthority` — so the entire Autonomy Line is dead code at runtime.
 * `nyst_authority_decisions` is written only by a test, so a real deployment's
 * decision history is permanently empty.
 *
 * What `POST /v1/actions` actually enforced: Emergency Freeze and Blast Radius,
 * via `admitConsequence`. Both real, both good. Neither is the Autonomy Line.
 *
 * SO THE HEADLINE INVARIANT WAS INVERTED IN PRODUCTION.
 *
 * `autonomyLine.ts` states it plainly, and a v0.3.0 test asserts it:
 *
 *     "An undescribed Agent has no autonomy, not unlimited autonomy."
 *
 * In production, an Agent with no Autonomy Line rule reached the provider.
 * Absent authority became FULL authority — the exact inversion of the design,
 * in the one place where being wrong has consequences.
 *
 * WHY NO TEST CAUGHT IT.
 *
 * `v030Authority` calls `evaluateAuthority()` directly and never touches HTTP.
 * The nine suites that drive `POST /v1/actions` never create an autonomy rule.
 * And the structural test asserted there is no SECOND evaluator — which was
 * true, and which is not the same as the one evaluator being used.
 *
 * That gap is what this file closes: every test here goes through the REAL
 * ROUTE and counts REAL PROVIDER INVOCATIONS.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { buildProductServer } from "../src/product/server.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 authority fixture 23!";

describe("Nyst v0.3.2 Phase 1 — Authority gates the real action path", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let authority: AuthorityRepository;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  let cookie: string;
  let csrf: string;
  let agentId: string;
  const suffix = randomUUID().slice(0, 8);

  /** Every provider dispatch that actually happened. The number that matters. */
  let providerCalls: { effect: string; business_key: string }[] = [];
  /**
   * The development fake, chosen deliberately.
   *
   * An earlier version of this file supplied a hand-rolled `commit` returning
   * `{ ok: true, resolution: {...} }`. Authority allowed the action, the
   * provider was reached, and then the route's downstream bookkeeping rejected
   * the shape and answered 500 -- which looks exactly like an authority failure
   * and is not one. Using the real runtime means a 200 here proves the whole
   * path, and the dispatch counter still proves the provider was reached.
   */
  let EFFECT = "";
  /** The development fake validates its input; an empty object fails schema. */
  const FAKE_INPUT = {
    repository_id: "nyst-fixtures/authority", principal_id: "alice",
    desired_permission: "none", scenario: "definitely_applied",
  } as const;
  let descriptors: readonly { effect_name: string }[] = [];

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    authority = new AuthorityRepository(pool);

    tenant = await repository.createBootstrap({
      organization: "Authority Co", organization_slug: `authority-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      // ENFORCED: shadow refuses everything anyway, which would make this suite
      // pass for entirely the wrong reason.
      environment: "Production", environment_slug: "production", mode: "enforced",
      email: `authority-${suffix}@test.test`, display_name: "Authority", password: PASSWORD,
    });

    const signer = Ed25519Signer.ephemeral(`authority-${suffix}`);
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });
    EFFECT = product.descriptors[0]!.effect_name;
    descriptors = product.descriptors;

    app = await buildProductServer({
      repository,
      authority,
      effect_specs: product.descriptors,
      runtime: product.runtime,
      production: false,
      signer,
      // The real commit, wrapped. Counting invocations is the whole point: a
      // test that asserts a 409 without asserting ZERO dispatches proves
      // nothing, because the refusal could have arrived after the mutation.
      commit: async (input: { effect: string; businessKey: string }, principal: unknown) => {
        providerCalls.push({ effect: input.effect, business_key: input.businessKey });
        return product.commit(input as never, principal as never);
      },
    } as never);

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `authority-${suffix}`, email: `authority-${suffix}@test.test`, password: PASSWORD },
    });
    cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
    csrf = String((login.json() as { csrf?: unknown }).csrf ?? "");

    /**
     * REMOVE THE BOOTSTRAP DEFAULT RULE.
     *
     * `createBootstrap` now creates one -- deliberately, so a new workspace is
     * usable -- and it covers reversible effects. That is correct behaviour and
     * it makes this file's premise stale: the whole point here is an Agent that
     * NO rule covers, and the default rule covers it.
     *
     * So it is disabled explicitly, which is also the more honest test: it
     * proves the gate holds when authority is genuinely absent, rather than
     * relying on a workspace happening not to have been given a default.
     */
    for (const rule of await authority.autonomyRules(tenant)) {
      await authority.disableAutonomyRule(tenant, rule.autonomy_rule_id);
    }

    // The EffectSpec must be ENABLED for this environment, or the route refuses
    // before authority is ever consulted and the suite passes for the wrong
    // reason -- which it did on the first run.
    await repository.configureEffectSpec(tenant, product.descriptors[0]!, true);
    await repository.configureIntegration(tenant, "github", "env:NYST_GITHUB_TOKEN").catch(() => null);

    const agent = await repository.createAgent(tenant, tenant.user_id, {
      name: "Gated Agent", slug: `gated-${suffix}`, owner: "Authority",
      description: "Exists to prove that an Agent with no rule has no autonomy.",
      framework: "unspecified", tags: [],
    });
    agentId = String((agent as { agent_id?: unknown }).agent_id ?? agent);
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  /** Attempt one consequential action through the REAL route. */
  async function act(businessKey: string) {
    providerCalls = [];
    const response = await app.inject({
      method: "POST", url: "/v1/actions",
      headers: { cookie, "x-nyst-csrf": csrf, "content-type": "application/json" },
      payload: { effect: EFFECT, businessKey, agent_id: agentId, input: FAKE_INPUT },
    });
    return { response, dispatches: providerCalls.length };
  }

  /* ============================================ THE HEADLINE INVERSION */

  it("THE DEFECT: an Agent with NO Autonomy Line rule does not reach the provider", async () => {
    // Everything else is in order: enabled EffectSpec, valid policy, enforced
    // environment, no freeze, budget headroom. The ONLY thing missing is a rule
    // saying what this Agent may do.
    const { response, dispatches } = await act(`no-rule-${suffix}`);

    assert.equal(dispatches, 0,
      "AN AGENT WITH NO AUTONOMY LINE RULE MUTATED A PROVIDER. " +
      "Absent authority became FULL authority — the exact inversion of the documented invariant.");
    assert.ok(response.statusCode === 409 || response.statusCode === 403,
      `expected the action to be held or blocked, got ${response.statusCode}: ${response.body}`);
    assert.match(response.body, /autonomy|no rule|asks a person|not unlimited/i,
      "the refusal does not explain that the Agent has no Autonomy Line rule");
  });

  it("a durable AuthorityDecision is recorded for that refusal", async () => {
    await act(`decision-${suffix}`);
    const decisions = await authority.decisions(tenant, 10);
    assert.ok(decisions.length > 0,
      "nyst_authority_decisions is EMPTY after a real action — the /autonomy page has no history to show");
    assert.ok(decisions.some((entry) => entry.disposition === "held" || entry.disposition === "blocked"));
  });

  it("and with an applicable rule, the same action proceeds", async () => {
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      agent_id: agentId, effect_name: EFFECT,
      disposition: "autonomous",
      rationale: "This Agent is permitted to perform this reversible effect autonomously in tests.",
    } as never);

    const { response, dispatches } = await act(`with-rule-${suffix}`);
    assert.equal(response.statusCode, 200,
      `an authorized action was refused: ${response.body}`);
    assert.equal(dispatches, 1, "an authorized action did not reach the provider");
  });

  /* ================================================ THE OTHER LAYERS */

  it("disposition=human HOLDS, and dispatches nothing", async () => {
    const held = await repository.createAgent(tenant, tenant.user_id, {
      name: "Human Agent", slug: `human-${suffix}`, owner: "Authority",
      description: "Requires a person.", framework: "unspecified", tags: [],
    });
    const heldId = String((held as { agent_id?: unknown }).agent_id ?? held);
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      agent_id: heldId, effect_name: EFFECT, disposition: "human",
      rationale: "A person decides every one of these until we have seen more of them.",
    } as never);

    providerCalls = [];
    const response = await app.inject({
      method: "POST", url: "/v1/actions",
      headers: { cookie, "x-nyst-csrf": csrf, "content-type": "application/json" },
      payload: { effect: EFFECT, businessKey: `human-${suffix}`, agent_id: heldId, input: FAKE_INPUT },
    });
    assert.equal(providerCalls.length, 0, "a human-required Agent reached the provider");
    assert.ok(response.statusCode >= 400);
  });

  it("disposition=disabled BLOCKS, and no exception can release it", async () => {
    const off = await repository.createAgent(tenant, tenant.user_id, {
      name: "Disabled Agent", slug: `disabled-${suffix}`, owner: "Authority",
      description: "Switched off.", framework: "unspecified", tags: [],
    });
    const offId = String((off as { agent_id?: unknown }).agent_id ?? off);
    await authority.createAutonomyRule(tenant, tenant.user_id, {
      agent_id: offId, effect_name: EFFECT, disposition: "disabled",
      rationale: "This Agent is switched off while we investigate an incident.",
    } as never);

    // Even WITH a live human exception, disabled must stay blocked: an
    // exception may release a hold, never a block.
    await authority.createException(tenant, tenant.user_id, {
      kind: "human_approval", authorizes: "autonomous_execution",
      agent_id: offId, effect_name: EFFECT,
      actor_role: "operator",
      reason: "Trying to release a blocked Agent, which must not work.",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    } as never).catch(() => null);

    providerCalls = [];
    const response = await app.inject({
      method: "POST", url: "/v1/actions",
      headers: { cookie, "x-nyst-csrf": csrf, "content-type": "application/json" },
      payload: { effect: EFFECT, businessKey: `disabled-${suffix}`, agent_id: offId, input: FAKE_INPUT },
    });
    assert.equal(providerCalls.length, 0,
      "A DISABLED AGENT REACHED THE PROVIDER — an exception released a BLOCK, which it may never do");
    assert.ok(response.statusCode >= 400);
  });

  /* ===================================================== STRUCTURAL */

  it("a new workspace gets a DESCRIBED default posture, scoped to reversible effects", async () => {
    // The counterpart to the test above. Absent authority is refused; a new
    // workspace is not left absent, it is given an explicit, visible, tightenable
    // rule -- and that rule does not cover irreversible effects.
    const fresh = await repository.createBootstrap({
      organization: "Fresh Co", organization_slug: `fresh-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Production", environment_slug: "production", mode: "enforced",
      email: `fresh-${suffix}@test.test`, display_name: "Fresh", password: PASSWORD,
    });
    const rules = await authority.autonomyRules(fresh);
    assert.equal(rules.length, 1, "a new workspace has no default Autonomy Line rule at all");
    assert.equal(rules[0]!.disposition, "autonomous");
    assert.equal(rules[0]!.requires_reversible, true,
      "THE DEFAULT RULE COVERS IRREVERSIBLE EFFECTS — where being wrong is permanent");
    assert.ok(String(rules[0]!.rationale).length > 40,
      "the default rule has no rationale a person could read on the Autonomy Line page");
  });

  it("STRUCTURAL: the action route calls the canonical evaluator", async () => {
    // The v0.3.0 structural test asserted there is no SECOND evaluator. True,
    // and not the same as the one evaluator being used — which is precisely how
    // this went unnoticed. This asserts USE.
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Walk up to the repository root. `import.meta.dirname/..` resolves to
    // `dist/` when this suite runs from a build, where there is no src/ -- so
    // the assertion would fail for a reason that has nothing to do with the
    // route. Same trap as the container-image suite.
    let root = import.meta.dirname;
    for (let depth = 0; depth < 6 && !existsSync(join(root, "src/product/server.ts")); depth += 1) {
      root = join(root, "..");
    }
    const source = readFileSync(join(root, "src/product/server.ts"), "utf8");
    const route = source.slice(source.indexOf('app.post("/v1/actions"'));
    const body = route.slice(0, route.indexOf('app.get("/v1/actions/:id"'));
    assert.match(body, /evaluateAuthority|authorizeConsequence/,
      "THE ACTION ROUTE DOES NOT CONSULT THE CANONICAL AUTHORITY EVALUATOR");
  });

  it("STRUCTURAL: the Authority layer cannot be omitted from a deployment", async () => {
    /**
     * The wiring hazard, closed structurally rather than by convention.
     *
     * `authority` used to be an optional server option, and a server built
     * without it dispatched consequences with no Autonomy Line check at all --
     * which is how absent authority became full authority in the first place.
     * Making the option REQUIRED would only have moved the mistake to every
     * call site; `buildProductServer` now constructs the layer from the
     * repository's own connection, so there is no configuration in which it is
     * missing.
     *
     * This asserts the consequence: a server built with NO authority option is
     * still gated.
     */
    // An agent NO rule covers. The shared one was granted an autonomous rule by
    // an earlier test in this file, so reusing it here proved nothing: the bare
    // server allowed it correctly, and the assertion read that as a bypass.
    const uncovered = await repository.createAgent(tenant, tenant.user_id, {
      name: "Uncovered Agent", slug: `uncovered-${suffix}`, owner: "Authority",
      description: "No Autonomy Line rule mentions this Agent.",
      framework: "unspecified", tags: [],
    });
    const uncoveredId = String((uncovered as { agent_id?: unknown }).agent_id ?? uncovered);

    providerCalls = [];
    const bare = await buildProductServer({
      repository,
      effect_specs: descriptors as never,
      production: false,
      commit: async () => { providerCalls.push({ effect: EFFECT, business_key: "bare" }); return { ok: true as const }; },
    } as never);
    try {
      const login = await bare.inject({
        method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
        payload: { organization: `authority-${suffix}`, email: `authority-${suffix}@test.test`, password: PASSWORD },
      });
      const bareCookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
      const bareCsrf = String((login.json() as { csrf?: unknown }).csrf ?? "");
      const response = await bare.inject({
        method: "POST", url: "/v1/actions",
        headers: { cookie: bareCookie, "x-nyst-csrf": bareCsrf, "content-type": "application/json" },
        payload: { effect: EFFECT, businessKey: `bare-${suffix}`, agent_id: uncoveredId, input: FAKE_INPUT },
      });
      assert.equal(providerCalls.length, 0,
        "A SERVER BUILT WITH NO AUTHORITY OPTION DISPATCHED A CONSEQUENCE — the defect returned as a config flag");
      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    } finally { await bare.close(); }
  });
});
