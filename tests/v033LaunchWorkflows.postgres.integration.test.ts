/**
 * Nyst v0.3.3 — THE FIRST PASS DRIVEN BY A REAL DEPLOYED SITE.
 *
 * v0.3.2 shipped against a laptop database with nothing deployed. Nyst is now
 * running on Render against managed PostgreSQL with Google sign-in working, and
 * the first person to click around it found four things in ten minutes. Every
 * one of them is a defect a test suite of 1125 did not have an opinion about,
 * because every one of them lives in the gap between a model and its caller.
 *
 * DEFECT A — THE DEAD FORM.
 *
 * The Failure Lab renders one `<form method="post" action="/v1/...">` per
 * outcome fault, tagged `data-lab-outcome`, and NOTHING LISTENS FOR IT. There
 * is a handler for `#lab-form` and one for the context switcher; there is none
 * for this. So the browser performs a NATIVE form POST: no CSRF header, no JSON
 * content type. The API answers 403 and the browser paints the raw JSON body in
 * its own viewer. The customer clicks a button on the flagship demonstration
 * page and lands on a black screen full of pretty-printed error JSON.
 *
 * The test that matters is not "this one form works". It is STRUCTURAL: no form
 * anywhere in the product may post to a `/v1/` endpoint without a handler bound
 * to it, because that combination is always this bug.
 *
 * DEFECT B — THE ENTITLEMENT GATE HAS NO CALLER. AGAIN.
 *
 * This is the third instance of the exact defect I named in the v0.3.2 final
 * report, and it is in the fix I wrote FOR that report. `setEnvironmentMode`
 * takes an optional `entitlements` argument and enforces it correctly. Every
 * one of the eleven Phase 10 tests calls the repository method DIRECTLY and
 * passes `entitlements` itself. `PUT /v1/environment/mode` does not pass it.
 *
 * So a trial organization could POST straight to the route and get Enforced —
 * which is the precise sentence the Phase 10 header comment claims to have
 * fixed. The tests proved the parameter works. Nothing proved the route uses
 * it. An optional safety argument is a defect generator: it fails OPEN, and it
 * fails silently, and it type-checks.
 *
 * DEFECT C — CREDENTIALS ARE AN OPERATOR FEATURE, SO THERE IS NO PRODUCT.
 *
 * v0.3.2 Phase 2 made credentials tenant-SCOPED, which was necessary and not
 * sufficient. Every reference still has to be `env:SOMETHING` — a process
 * environment variable. A customer who signs up on the hosted site cannot set
 * an environment variable on someone else's Render instance, so there is no
 * path by which anybody but the operator can ever connect a provider.
 *
 * Nyst was multi-tenant in its data model and single-tenant in its onboarding.
 *
 * THE ADVERSARIAL CASE, which is the one that matters: once a credential can be
 * addressed by an id, one tenant can name another tenant's id. The resolver
 * MUST be scope-bound, not id-bound. That is the test with teeth here.
 *
 * NO REAL PROVIDER CREDENTIAL APPEARS IN THIS FILE. The tokens are
 * provider-SHAPED fixtures.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ed25519Signer } from "../src/core/signing.js";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { AuthorityRepository } from "../src/product/authority/authorityRepository.js";
import { EntitlementRepository } from "../src/product/entitlementRepository.js";
import { TenantCredentialStore } from "../src/product/tenantCredentials.js";
import { buildProductServer } from "../src/product/server.js";
import { createProductProviderRuntime } from "../src/product/providerRuntimeFactory.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import { APP_JS } from "../src/product/assets.js";
import { NYST_CSS } from "../src/product/designSystem.js";
import { loginPage } from "../src/product/dashboard.js";
import type { TenantScope } from "../src/product/types.js";
import { MutableClock } from "./githubHelpers.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v033 workflow fixture 23!";
/** A 32-byte key, base64. A FIXTURE. Never a deployment key. */
const FIXTURE_KEY = Buffer.alloc(32, 7).toString("base64");
/** Provider-SHAPED, deliberately not a real token. */
const FIXTURE_GITHUB = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;

const root = (() => {
  let candidate = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(candidate, "src/product/assets.ts"))) return candidate;
    candidate = join(candidate, "..");
  }
  throw new Error("could not locate the repository root");
})();

/* ==================================================================== */
/* A + E + D: no database, no network. Structural and presentational.   */
/* ==================================================================== */

describe("Nyst v0.3.3 — the dead form, the logo, and the layout", () => {

  /**
   * THE STRUCTURAL RULE.
   *
   * A `<form>` whose action is a `/v1/` endpoint is ALWAYS a JSON+CSRF API
   * call, and a native browser POST to one is ALWAYS refused. So every such
   * form needs a submit handler. Finding them by hand is how this was missed;
   * this counts them instead.
   */
  it("THE DEFECT: every form posting to /v1/ has a JavaScript handler bound to it", () => {
    const handled = new Set<string>();
    // Handlers are bound either by element id (#lab-form) or by data attribute
    // (data-lab-outcome). Collect both vocabularies from the shipped script.
    for (const match of APP_JS.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) handled.add(`#${match[1]}`);
    for (const match of APP_JS.matchAll(/querySelectorAll?\("\[data-([a-z-]+)\]"\)/g)) handled.add(`@${match[1]}`);
    for (const match of APP_JS.matchAll(/dataset\.([A-Za-z0-9]+)/g)) handled.add(`@${kebab(match[1]!)}`);
    for (const match of APP_JS.matchAll(/closest\("\[data-([a-z-]+)\]"\)/g)) handled.add(`@${match[1]}`);

    const orphans: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const form of text.matchAll(/<form[^>]*action="(\/v1\/[^"]*)"[^>]*>/g)) {
        const tag = form[0]!;
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        const attributes = [...tag.matchAll(/\bdata-([a-z-]+)=/g)].map((attribute) => `@${attribute[1]}`);
        const bound = (id !== undefined && handled.has(`#${id}`)) || attributes.some((name) => handled.has(name));
        if (!bound) orphans.push(`${file.slice(root.length + 1)}: <form action="${form[1]}"> has no handler`);
      }
    }
    assert.deepEqual(orphans, [],
      "A FORM POSTS TO A JSON+CSRF API WITH NOTHING INTERCEPTING IT. The browser will perform a native "
      + "form POST, the API will answer 403, and the customer will see raw JSON on a blank page:\n  "
      + orphans.join("\n  "));
  });

  it("the Failure Lab outcome control is bound by name, not by hope", () => {
    assert.match(APP_JS, /data-lab-outcome/,
      "nothing in the shipped script mentions the Failure Lab outcome forms");
    // It must render the verdict in the page. Reloading would discard the run,
    // because the result is computed and returned, never stored.
    assert.match(APP_JS, /renderOutcomeRun|lab-outcome-result/,
      "the handler does not render the verdict, so the customer clicks and sees nothing happen");
  });

  it("a failed lab run reports the reason and never navigates away", () => {
    // The failure mode being replaced was a full page navigation to a JSON
    // body. Whatever happens, the customer stays on the page.
    //
    // Scoped to the lab handler ONLY. Other handlers navigate deliberately —
    // connecting a credential reloads because readiness genuinely changed — so
    // a whole-file assertion here would be measuring the wrong thing.
    const start = APP_JS.indexOf('form[data-lab-outcome]');
    const end = APP_JS.indexOf("function renderOutcomeRun");
    assert.ok(start > 0 && end > start, "could not locate the Failure Lab handler");
    assert.doesNotMatch(APP_JS.slice(start, end), /location\.href|location\.reload/,
      "the Failure Lab handler navigates, which is the behaviour that produced the black screen");
  });

  /* ------------------------------------------------------ THE LOGO */

  it("the Nyst logo sits on a plate, so a blue mark is not lost on a navy sidebar", () => {
    assert.match(NYST_CSS, /\.brand-plate/,
      "the logo has no backing plate and the blue mark blends into the sidebar");
    const plate = /\.brand-plate\s*\{([^}]*)\}/.exec(NYST_CSS)?.[1] ?? "";
    assert.match(plate, /background/, "the plate has no background, so it is not a plate");
  });

  /**
   * EVERY navy surface, not just the one that was reported.
   *
   * Fixing the sidebar and shipping was the wrong-sized fix: the SIGN-IN page
   * puts the nyst.ai wordmark on the same navy, in the same navy, and it was
   * the first thing a customer ever saw of the brand. The test is written over
   * the set of dark surfaces rather than over the one that got noticed.
   */
  it("the wordmark on the sign-in page is on a plate too", () => {
    const page = loginPage({} as never);
    const logo = /<img[^>]*nyst-domain-wordmark[^>]*>/.exec(page)?.[0];
    assert.ok(logo, "the sign-in wordmark is missing entirely");
    assert.match(page, /<span class="brand-plate-wide">\s*<img[^>]*nyst-domain-wordmark/,
      "THE SIGN-IN WORDMARK IS NAVY ON NAVY. It is drawn in the same colour as the panel behind it, so "
      + "the first thing a customer sees of the brand is a blank space.");
    const plate = /\.brand-plate-wide\s*\{([^}]*)\}/.exec(NYST_CSS)?.[1] ?? "";
    assert.match(plate, /background:\s*#fff|background:\s*#FFF|background:\s*white/,
      "the wordmark plate has no light background");
  });

  it("no logo sits directly on a navy surface anywhere", () => {
    // The general rule, so the next dark surface added does not repeat this.
    const dashboard = readFileSync(join(root, "src/product/dashboard.ts"), "utf8");
    const bare = [...dashboard.matchAll(/(.{60})<img src="\/brand\/nyst-[a-z-]+\.png"/g)]
      .filter((match) => !/brand-plate(-wide)?">\s*$/.test(match[1]!))
      .map((match) => match[0].slice(-70));
    assert.deepEqual(bare, [],
      `a brand image is rendered without a plate on a dark surface:\n  ${bare.join("\n  ")}`);
  });

  /* ------------------------------------------------- THE LAYOUT */

  it("THE DEFECT: the content area is not capped to a fixed pixel width", () => {
    // 1180px on a 2560px screen wastes more than half the display. The measure
    // cap belongs on PROSE, which is what --measure is for, not on the shell.
    const content = /\.content\s*\{([^}]*)\}/.exec(NYST_CSS)?.[1] ?? "";
    assert.ok(content.length > 0, "no .content rule found");
    assert.doesNotMatch(content, /max-width:\s*\d{3,4}px/,
      "THE CONTENT AREA IS PINNED TO A FIXED PIXEL WIDTH. On a large display most of the screen is "
      + "empty while tables scroll horizontally inside a narrow column.");
  });

  it("the shell scales with the viewport rather than stepping at one breakpoint", () => {
    assert.match(NYST_CSS, /clamp\(/,
      "nothing in the sheet uses clamp(), so nothing scales continuously with the viewport");
    // The sidebar is the other half: a fixed nav width on a small laptop is as
    // wrong as a fixed content width on a large monitor.
    const navWidth = /--nav-width:\s*([^;]+);/.exec(NYST_CSS)?.[1] ?? "";
    assert.match(navWidth, /clamp\(|min\(|max\(/,
      "the sidebar is a fixed width at every viewport size");
  });

  it("prose still has a reading measure — fluid layout is not unbounded line length", () => {
    // Full-width BODY TEXT is its own defect. Widening the shell must not widen
    // the paragraphs, or this fix trades one usability problem for another.
    assert.match(NYST_CSS, /--measure:/, "the reading measure token was removed");
    assert.match(NYST_CSS, /\.lede\s*\{[^}]*max-width:\s*var\(--measure\)/,
      "lede paragraphs no longer respect the reading measure");
  });

  /* ------------------------------------------------ THE GOOGLE BUTTON */

  it("THE DEFECT: Google sign-in is a real button with the Google mark, not blue underlined text", () => {
    const page = loginPage({ google: true } as never);
    assert.match(page, /class="[^"]*google-signin/, "the Google control is not a branded button");
    // The four-colour G, inline. An external image host would be blocked by the
    // CSP and would leak a request to Google on every login page view.
    assert.match(page, /<svg[^>]*viewBox="0 0 48 48"/, "the Google mark is missing");
    for (const colour of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
      assert.ok(page.includes(colour), `the Google mark is missing its ${colour} path`);
    }
    assert.match(page, /Sign in with Google/, "the button does not carry the required wording");
  });

  it("the Google button loads no external resource", () => {
    const page = loginPage({ google: true } as never);
    assert.doesNotMatch(page, /https:\/\/(?:www\.)?(?:google|gstatic|googleapis)\.com\/[^"]*\.(?:png|svg|jpg|css|js)/,
      "the button references an asset on a Google host: the CSP blocks it and it leaks a request");
  });

  it("no Google button is rendered when Google is not configured", () => {
    const page = loginPage({} as never);
    assert.doesNotMatch(page, /google-signin/,
      "a Google button is shown on a deployment with no Google client, so it can only fail");
  });
});

/* ==================================================================== */
/* B + C: the real routes, against the real database.                   */
/* ==================================================================== */

describe("Nyst v0.3.3 — connect a provider and leave Shadow, over HTTP", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let entitlements: EntitlementRepository;
  let credentials: TenantCredentialStore;
  let app: Awaited<ReturnType<typeof buildProductServer>>;
  let tenant: TenantScope & { user_id: string };
  let other: TenantScope & { user_id: string };
  let cookie = "";
  let csrf = "";
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    entitlements = new EntitlementRepository(pool);
    credentials = new TenantCredentialStore(pool, FIXTURE_KEY);

    tenant = await repository.createBootstrap({
      organization: "Workflow Co", organization_slug: `wf-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `wf-${suffix}@test.test`, display_name: "Workflow", password: PASSWORD,
    });
    other = await repository.createBootstrap({
      organization: "Other Co", organization_slug: `other-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: `other-${suffix}@test.test`, display_name: "Other", password: PASSWORD,
    });

    const signer = Ed25519Signer.ephemeral(`workflow-${suffix}`);
    const product = createProductProviderRuntime(store, repository, signer, new MutableClock(),
      { production: false, enable_development_fake: true });

    app = await buildProductServer({
      repository,
      authority: new AuthorityRepository(pool),
      entitlements,
      tenant_credentials: credentials,
      effect_specs: product.descriptors,
      runtime: product.runtime,
      production: false,
      signer,
      commit: product.commit,
    } as never);

    const login = await app.inject({
      method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
      payload: { organization: `wf-${suffix}`, email: `wf-${suffix}@test.test`, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
    csrf = String((login.json() as { csrf?: unknown }).csrf ?? "");
  });
  after(async () => { await app.close(); await store.close(); await pool.end(); });

  const auth = () => ({ cookie, "x-nyst-csrf": csrf, "content-type": "application/json" });

  /* ============================================ B — THE ROUTE, NOT THE METHOD */

  it("THE DEFECT: a TRIAL organization is refused Enforced BY THE HTTP ROUTE", async () => {
    // Every Phase 10 test called the repository method directly and handed it
    // the entitlements object. This one does what a customer does.
    const response = await app.inject({
      method: "PUT", url: "/v1/environment/mode", headers: auth(),
      payload: { mode: "enforced", reason: "We would like Nyst to actually control things." },
    });
    assert.equal(response.statusCode, 402,
      `A TRIAL ORGANIZATION MOVED AN ENVIRONMENT TO ENFORCED THROUGH THE PUBLIC ROUTE. `
      + `The entitlement argument is optional and the route never passed it. Got ${response.statusCode}.`);
    const body = response.json() as { detail?: string; blocked_by?: string; remedy?: string };
    assert.equal(body.blocked_by, "entitlement");
    assert.ok((body.remedy ?? "").length > 0, "a commercial refusal carries no remedy, so it is a dead end");

    const control = await app.inject({ method: "GET", url: "/v1/environment", headers: { cookie } });
    assert.equal((control.json() as { mode?: string }).mode, "shadow", "the mode changed despite the refusal");
  });

  it("a commercial refusal is distinguishable from a safety refusal", async () => {
    // 402 and 409 must never be collapsed. One says "upgrade"; the other says
    // "this is not safe yet". A UI that renders them identically is lying about
    // one of them.
    const response = await app.inject({
      method: "PUT", url: "/v1/environment/mode", headers: auth(),
      payload: { mode: "enforced", reason: "Trying again with the same plan." },
    });
    assert.equal(response.statusCode, 402);
    assert.notEqual(response.statusCode, 409);
  });

  it("returning to SHADOW is never gated, even on an expired trial", async () => {
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "trial",
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      changed_by: null, reason: "Trial ended in this test.",
    });
    const response = await app.inject({
      method: "PUT", url: "/v1/environment/mode", headers: auth(),
      payload: { mode: "shadow", reason: "Standing down while we sort out billing." },
    });
    assert.equal(response.statusCode, 200,
      "AN EXPIRED CUSTOMER WAS CHARGED FOR THE ABILITY TO STOP CONTROLLING THINGS");
  });

  it("with the plan, the same route allows it", async () => {
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "protect",
      changed_by: null, reason: "Signed a Protect contract in this test.",
    });
    const response = await app.inject({
      method: "PUT", url: "/v1/environment/mode", headers: auth(),
      payload: { mode: "enforced", reason: "Shadow findings reviewed; promoting deliberately." },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as { mode?: string }).mode, "enforced");
    // Put it back: later tests read this environment.
    await app.inject({
      method: "PUT", url: "/v1/environment/mode", headers: auth(),
      payload: { mode: "shadow", reason: "Restoring the fixture baseline." },
    });
  });

  /* ========================================= C — CONNECTING A PROVIDER */

  it("THE DEFECT: a customer can supply their own credential over HTTP", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/integrations/github/credential", headers: auth(),
      payload: { credential: FIXTURE_GITHUB },
    });
    assert.equal(response.statusCode, 200,
      `THERE IS NO SELF-SERVE PATH TO CONNECT A PROVIDER, so only the operator can ever connect one. `
      + `Got ${response.statusCode}: ${response.body.slice(0, 300)}`);
    const body = response.json() as Record<string, unknown>;
    assert.match(String(body.credential_ref), /^tenant:[0-9a-f-]{36}$/,
      "the stored reference is not a tenant-scoped reference");
    assert.ok(String(body.fingerprint ?? "").length >= 8, "nothing identifies WHICH credential is loaded");
  });

  it("THE SECRET IS NEVER ECHOED BACK, in any response or any page", async () => {
    const connect = await app.inject({
      method: "POST", url: "/v1/integrations/github/credential", headers: auth(),
      payload: { credential: FIXTURE_GITHUB },
    });
    // Asserted FIRST, or this whole test passes vacuously on any failure: a 500
    // body does not contain the credential either.
    assert.equal(connect.statusCode, 200, connect.body);
    assert.ok(!connect.body.includes(FIXTURE_GITHUB), "THE CONNECT RESPONSE CONTAINED THE CREDENTIAL");

    for (const url of ["/integrations", "/settings", "/v1/integrations"]) {
      const page = await app.inject({ method: "GET", url, headers: { cookie } });
      assert.ok(!page.body.includes(FIXTURE_GITHUB), `${url} RENDERED THE CREDENTIAL`);
      // The fingerprint is a keyed digest, so it identifies without disclosing.
      assert.ok(!page.body.includes(FIXTURE_GITHUB.slice(-8)),
        `${url} rendered a suffix of the credential — a partial secret is still a secret`);
    }
  });

  it("THE CIPHERTEXT IS NOT THE PLAINTEXT — the column never holds a readable token", async () => {
    await app.inject({
      method: "POST", url: "/v1/integrations/github/credential", headers: auth(),
      payload: { credential: FIXTURE_GITHUB },
    });
    const rows = (await pool.query(
      `SELECT ciphertext FROM nyst_tenant_credentials WHERE organization_id=$1`, [tenant.organization_id])).rows;
    assert.ok(rows.length > 0, "nothing was stored");
    for (const row of rows) {
      const raw = Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(String(row.ciphertext));
      assert.ok(!raw.toString("utf8").includes(FIXTURE_GITHUB),
        "THE CREDENTIAL IS STORED IN PLAINTEXT. A database backup is now a credential dump.");
      assert.ok(!raw.toString("utf8").includes("ghp_"), "the token prefix survived into storage");
    }
  });

  it("THE ADVERSARIAL CASE: one tenant cannot resolve another tenant's credential", async () => {
    // The whole risk introduced by addressing credentials with an id. If the
    // resolver is id-bound rather than scope-bound, Nyst acts on Acme's
    // repositories with Globex's token — the v0.3.2 Phase 2 defect, restored
    // through a new door.
    const stored = await credentials.store(tenant, tenant.user_id, "github", FIXTURE_GITHUB);

    const asOther = credentials.scopedTo(other);
    await assert.rejects(
      () => asOther.resolve(stored.credential_ref),
      (error: Error) => {
        assert.doesNotMatch(error.message, new RegExp(FIXTURE_GITHUB), "the failure quoted the secret");
        return true;
      },
      "ANOTHER ORGANIZATION RESOLVED THIS TENANT'S CREDENTIAL BY NAMING ITS ID");

    // And the owner still can, or the check is merely broken rather than safe.
    assert.equal(await credentials.scopedTo(tenant).resolve(stored.credential_ref), FIXTURE_GITHUB);
  });

  it("a revoked credential stops resolving immediately — no cache, no window", async () => {
    const stored = await credentials.store(tenant, tenant.user_id, "github", FIXTURE_GITHUB);
    const source = credentials.scopedTo(tenant);
    assert.equal(await source.resolve(stored.credential_ref), FIXTURE_GITHUB);

    await credentials.revoke(tenant, stored.credential_ref, "Rotated in this test.");
    await assert.rejects(() => source.resolve(stored.credential_ref),
      "A REVOKED CREDENTIAL STILL RESOLVED. The same source instance had already resolved it once, "
      + "so something is caching a secret past its revocation.");
  });

  it("storing a new credential REPLACES the old one rather than accumulating live secrets", async () => {
    await credentials.store(tenant, tenant.user_id, "okta", "okta-fixture-token-one-000000");
    await credentials.store(tenant, tenant.user_id, "okta", "okta-fixture-token-two-000000");
    const live = (await pool.query(
      `SELECT count(*)::int AS count FROM nyst_tenant_credentials
       WHERE organization_id=$1 AND provider='okta' AND revoked_at IS NULL`,
      [tenant.organization_id])).rows[0]!;
    assert.equal(Number(live.count), 1,
      "two live credentials exist for one provider in one environment, so which one Nyst uses is ambiguous");
  });

  it("a credential that is obviously not a credential is refused before it is stored", async () => {
    for (const rubbish of ["", "   ", "x"]) {
      const response = await app.inject({
        method: "POST", url: "/v1/integrations/github/credential", headers: auth(),
        payload: { credential: rubbish },
      });
      assert.equal(response.statusCode, 400, `"${rubbish}" was accepted as a GitHub credential`);
    }
  });

  it("a deployment with no encryption key REFUSES to store rather than storing plaintext", async () => {
    // Failing closed is the only acceptable behaviour. The alternative is a
    // deployment that silently works and holds readable customer tokens.
    assert.throws(() => new TenantCredentialStore(pool, ""), /encryption key/i);
    assert.throws(() => new TenantCredentialStore(pool, Buffer.alloc(8).toString("base64")), /32 bytes|too short/i);
  });

  /**
   * FOUND ON THE DEPLOYED SITE, and it is not a credential bug.
   *
   * The operator set up Render without NYST_CREDENTIAL_KEY, pasted a token, and
   * got `internal_error`. The route did exactly the right thing — it threw 503
   * with a paragraph naming the missing variable. The ERROR HANDLER threw that
   * paragraph away:
   *
   *     const status = candidate >= 400 && candidate < 500 ? candidate : 500;
   *     if (status === 500) return reply.send({ error: "internal_error" });
   *
   * 503 is not inside 400..499, so it collapsed to 500 and the message was
   * discarded as if it were an unvetted stack trace.
   *
   * THE BLAST RADIUS IS EVERY 503 IN THE CODEBASE. "No SecretProvider is
   * configured", "No credential store is configured", every readiness and
   * preflight guard — all of them have been reaching operators as
   * `internal_error`, which is both alarming and useless. That is the exact
   * defect the handler's own comment claims to have fixed for 4xx.
   *
   * The security property is unchanged: a message is surfaced only when NYST
   * set the status deliberately. An unexpected throw still says nothing.
   */
  it("THE DEFECT: a deliberate 503 keeps its message instead of becoming internal_error", async () => {
    // A server built WITHOUT a credential store: exactly the deployed setup.
    const bare = await buildProductServer({
      repository, authority: new AuthorityRepository(pool), entitlements,
      effect_specs: [], production: false,
    } as never);
    try {
      const login = await bare.inject({
        method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
        payload: { organization: `wf-${suffix}`, email: `wf-${suffix}@test.test`, password: PASSWORD },
      });
      const bareCookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
      const bareCsrf = String((login.json() as { csrf?: unknown }).csrf ?? "");

      const response = await bare.inject({
        method: "POST", url: "/v1/integrations/github/credential",
        headers: { cookie: bareCookie, "x-nyst-csrf": bareCsrf, "content-type": "application/json" },
        payload: { credential: FIXTURE_GITHUB },
      });
      assert.equal(response.statusCode, 503,
        `A DELIBERATE 503 WAS COLLAPSED TO ${response.statusCode}. The operator is told "internal_error" `
        + "for a configuration problem they could fix in thirty seconds.");
      const body = response.json() as { error?: string; detail?: string };
      assert.notEqual(body.error, "internal_error");
      assert.match(String(body.detail), /NYST_CREDENTIAL_KEY/,
        "the refusal does not name the variable that is missing, so it is not actionable");
      assert.match(String(body.detail), /plaintext/i,
        "the refusal does not say WHY it refuses rather than degrading");
    } finally { await bare.close(); }
  });

  it("an UNEXPECTED failure still says nothing beyond a request id", async () => {
    // The security property the collapse existed to protect. Only statuses NYST
    // sets deliberately may carry a message; a genuine 500 must not.
    const leaky = await buildProductServer({
      repository, authority: new AuthorityRepository(pool), entitlements,
      effect_specs: [], production: false,
    } as never);
    leaky.get("/v1/__boom", async () => { throw new Error("SELECT secret FROM internals -- do not leak me"); });
    await leaky.ready();
    try {
      const response = await leaky.inject({ method: "GET", url: "/v1/__boom", headers: { cookie } });
      assert.equal(response.statusCode, 500);
      assert.doesNotMatch(response.body, /do not leak me/, "AN UNEXPECTED ERROR LEAKED ITS MESSAGE");
      assert.equal((response.json() as { error?: string }).error, "internal_error");
    } finally { await leaky.close(); }
  });

  it("a deployment that cannot hold credentials does not offer a box to paste one into", async () => {
    // Showing the form anyway is worse than useless: the customer types a REAL
    // secret into a field whose only possible outcome is a failure.
    const bare = await buildProductServer({
      repository, authority: new AuthorityRepository(pool), entitlements,
      effect_specs: [], production: false, secrets: { async resolve() { throw new Error("none"); } },
    } as never);
    try {
      const login = await bare.inject({
        method: "POST", url: "/v1/auth/login", headers: { "content-type": "application/json" },
        payload: { organization: `wf-${suffix}`, email: `wf-${suffix}@test.test`, password: PASSWORD },
      });
      const page = await bare.inject({
        method: "GET", url: "/integrations",
        headers: { cookie: String(login.headers["set-cookie"] ?? "").split(";")[0]! },
      });
      assert.equal(page.statusCode, 200);
      assert.doesNotMatch(page.body, /data-connect-provider/,
        "A PASTE-YOUR-TOKEN FORM IS SHOWN ON A DEPLOYMENT THAT CANNOT STORE ONE");
      assert.match(page.body, /NYST_CREDENTIAL_KEY/,
        "the page does not say why connecting is unavailable, so nobody can fix it");
    } finally { await bare.close(); }
  });

  it("connecting requires CSRF, like every other state-changing request", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/integrations/github/credential",
      headers: { cookie, "content-type": "application/json" },
      payload: { credential: FIXTURE_GITHUB },
    });
    assert.equal(response.statusCode, 403, "a credential could be planted without a CSRF token");
  });

  /* ================================== THE PROMOTION VIEW ITSELF */

  it("the promotion view names every unmet condition, not a bare refusal", async () => {
    await entitlements.setEntitlement({
      organization_id: tenant.organization_id, state: "trial",
      changed_by: null, reason: "Back to trial for the promotion view test.",
    });
    const response = await app.inject({ method: "GET", url: "/v1/environment/promotion", headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      current_mode?: string;
      targets?: Array<{ mode: string; allowed: boolean; blockers: Array<{ reason: string; remedy: string | null }> }>;
    };
    assert.equal(body.current_mode, "shadow");
    const enforced = (body.targets ?? []).find((target) => target.mode === "enforced");
    assert.ok(enforced, "the promotion view does not describe Enforced at all");
    assert.equal(enforced.allowed, false);
    assert.ok(enforced.blockers.length > 0, "Enforced is refused with no stated reason");
    for (const blocker of enforced.blockers) {
      assert.ok(blocker.reason.length > 12, `a blocker with no readable reason: ${JSON.stringify(blocker)}`);
    }
  });

  it("the promotion view never reports a provider as connected on a claim alone", async () => {
    // Configured is not verified. A credential that has been stored but never
    // preflighted must not read as a working connection.
    const response = await app.inject({ method: "GET", url: "/v1/environment/promotion", headers: { cookie } });
    const body = response.json() as { providers?: Array<{ provider: string; connected: boolean; verified: boolean }> };
    const github = (body.providers ?? []).find((provider) => provider.provider === "github");
    assert.ok(github, "the promotion view does not mention GitHub");
    assert.equal(github.verified, false,
      "A STORED CREDENTIAL WAS REPORTED AS VERIFIED without a successful read-only preflight");
  });
});

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}
