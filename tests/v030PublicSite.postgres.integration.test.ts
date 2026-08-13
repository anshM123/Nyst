/**
 * Nyst v0.3.0 — Phases 37-45, 53. THE PUBLIC SITE.
 *
 * The spec's hardest requirement here is not visual, it is behavioural:
 *
 *     At EVERY animation frame — Contact works, Talk to us works, Start in
 *     Shadow works, navigation works, keyboard works, scroll stays normal,
 *     fast scrolling skips animations, browser back works, mobile is usable.
 *
 * A site that traps a visitor in an intro is worse than a plain one, so most
 * of this file is about proving the motion cannot get in anyone's way: no wheel
 * handler, no scroll hijack, no forced timeline, every scene readable with
 * JavaScript off, and the whole thing gated behind prefers-reduced-motion.
 *
 * The other half is commercial honesty. Entitlement may refuse a feature. It
 * may never touch a safety constraint, and there is no code path by which it
 * could.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { registerPublicRoutes } from "../src/public/publicRoutes.js";
import { PLANS, PRICING_PROMISE, plan } from "../src/public/pricing.js";
import { recommendPlan, type QuoteInput } from "../src/public/configurator.js";
import {
  COMMERCIAL_STATES, ENTITLEMENT_DISCLAIMER, entitlementFor, mayEnable, type CommercialState,
} from "../src/public/commercialEntitlement.js";
import { SITE_CSS, SITE_JS } from "../src/public/siteAssets.js";

describe("Nyst v0.3.0 Phases 37-45 — the public site", () => {
  let app: ReturnType<typeof Fastify>;

  before(async () => {
    app = Fastify({ logger: false });
    registerPublicRoutes(app);
    await app.ready();
  });
  after(async () => { await app.close(); });

  async function page(path: string): Promise<string> {
    const response = await app.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200, `${path} answered ${response.statusCode}`);
    return response.body;
  }

  /* ===================================================== THE OPENING */

  it("the opening establishes the name without claiming Nyst means outcome", async () => {
    const html = await page("/");
    assert.match(html, /nyst/);
    assert.match(html, /निष्ठा/, "the Devanagari is missing");
    assert.match(html, /niṣṭhā/, "the transliteration is missing");
    assert.match(html, /steadfastness · constancy · a state firmly established/);
    assert.match(html, /the outcome must be established before software is allowed to act again/);
    // The claim the spec explicitly forbids. It is not true, and a company that
    // opens with a slightly-false etymology has told you something.
    assert.doesNotMatch(html, /literally means outcome|means "outcome"|means outcome/i,
      "the site claims Nyst literally means outcome");
  });

  it("the technical value is established immediately, not after the story", async () => {
    const html = await page("/");
    const heroEnd = html.indexOf('class="story"');
    const hero = html.slice(0, heroEnd > 0 ? heroEnd : html.length);
    assert.match(hero, /Know what your agents actually changed/);
    assert.match(hero, /independently establishes the outcome of consequential AI-agent actions/);
    assert.match(hero, /controls what they may safely do next/);
  });

  /* ============================== MOTION MUST NEVER HURT UX */

  it("THE RULE: no scroll hijacking, no forced timeline, no pointer blocking", () => {
    // Every mechanism that could trap a visitor, checked by name.
    for (const hostile of [
      /addEventListener\(\s*["']wheel/, /addEventListener\(\s*["']touchmove/,
      /addEventListener\(\s*["']scroll/, /preventDefault/, /scrollTo\(/, /scrollIntoView/,
      /requestAnimationFrame/, /setTimeout/, /setInterval/, /history\.(push|replace)State/,
      /overflow\s*:\s*hidden/,
    ]) {
      assert.doesNotMatch(SITE_JS, hostile, `the site script uses ${hostile} — motion must never take control from the visitor`);
    }
    assert.doesNotMatch(SITE_CSS, /pointer-events\s*:\s*none/,
      "the site CSS disables pointer events somewhere, which can swallow a click on Contact");
    assert.doesNotMatch(SITE_CSS, /position\s*:\s*fixed[^}]*inset\s*:\s*0/,
      "a full-screen fixed overlay exists, which is how visitors get trapped in an intro");
    // Scroll stays the browser's.
    assert.doesNotMatch(SITE_CSS, /scroll-snap-type\s*:\s*[xy]\s+mandatory/,
      "mandatory scroll snapping takes scrolling away from the visitor");
  });

  it("every scene is fully readable with JavaScript disabled", async () => {
    const html = await page("/");
    // The hidden state is applied BY SCRIPT, via data-observed="pending". The
    // server never emits it, so a visitor without JavaScript sees everything.
    assert.doesNotMatch(html, /data-observed="pending"/,
      "the server emits the hidden state, so a visitor without JavaScript sees blank scenes");
    assert.match(SITE_JS, /setAttribute\("data-observed", "pending"\)/,
      "the hidden state is not applied from script");
    // And the CSS only hides what the script marked.
    assert.match(SITE_CSS, /\.scene\[data-observed="pending"\]/);
    // All thirteen scenes are present in the markup.
    for (let scene = 1; scene <= 13; scene += 1) {
      assert.match(html, new RegExp(`data-scene="${scene}"`), `scene ${scene} is missing`);
    }
  });

  it("all motion is gated behind prefers-reduced-motion", () => {
    // Every keyframe animation must sit inside a no-preference block.
    const blocks = SITE_CSS.split("@media (prefers-reduced-motion: no-preference)");
    const outsideBlocks = blocks[0]!;
    assert.doesNotMatch(outsideBlocks, /animation\s*:/,
      "an animation runs regardless of the visitor's reduced-motion setting");
    assert.match(SITE_JS, /prefers-reduced-motion: reduce/,
      "the script does not check the reduced-motion setting");
    // And it checks it before doing anything at all.
    const guardIndex = SITE_JS.indexOf("prefers-reduced-motion");
    const observerIndex = SITE_JS.indexOf("IntersectionObserver");
    assert.ok(guardIndex < observerIndex, "the reduced-motion check runs after the observer is set up");
  });

  it("the logo does not spin", () => {
    // A spinning loop mark is the single most common way to make a careful
    // brand look like a loading spinner.
    const rotations = SITE_CSS.match(/rotate\(/g) ?? [];
    assert.equal(rotations.length, 0, "the site CSS rotates something");
    assert.doesNotMatch(SITE_CSS, /animation[^;]*spin/i);
  });

  /* ============================================ NAVIGATION AND CONTACT */

  it("CONTACT IS NEVER GATED: no session, no signup, no JavaScript, from every page", async () => {
    const contact = await app.inject({ method: "GET", url: "/contact" });
    assert.equal(contact.statusCode, 200);
    // A real form with a real method and action, which works without script.
    assert.match(contact.body, /<form[^>]*method="post"[^>]*action="\/contact"/);
    assert.match(contact.body, /mailto:hello@nyst\.ai/, "there is no way to email us without using the form");
    assert.doesNotMatch(contact.body, /sign in to continue|create an account to contact/i);

    // And it is linked from every public page, including the footer.
    for (const path of ["/", "/product", "/pricing", "/security", "/privacy", "/terms", "/configure"]) {
      const html = await page(path);
      assert.match(html, /href="\/contact"/, `${path} does not link to Contact`);
      assert.match(html, /href="\/signup\?plan=shadow_trial"/, `${path} does not offer Start in Shadow`);
    }
  });

  it("the navigation is real markup, present before any scene", async () => {
    const html = await page("/");
    const navIndex = html.indexOf('class="site-nav"');
    const storyIndex = html.indexOf('class="story"');
    assert.ok(navIndex > 0 && navIndex < storyIndex, "the navigation is not before the story in the document");
    for (const [href] of [["/product"], ["/outcomes-explained"], ["/integrations-public"], ["/security"], ["/pricing"], ["/contact"]]) {
      assert.match(html, new RegExp(`href="${href!.replace(/\//g, "\\/")}"`), `${href} is missing from the navigation`);
    }
    // Keyboard first: the skip link is the first focusable thing.
    assert.match(html, /<a class="skip" href="#main">/);
    assert.ok(html.indexOf('class="skip"') < navIndex);
  });

  it("every page is a complete accessible document", async () => {
    for (const path of ["/", "/product", "/pricing", "/security", "/contact", "/configure", "/privacy", "/terms"]) {
      const html = await page(path);
      assert.match(html, /<html lang="en">/, `${path} has no language`);
      assert.match(html, /<meta name="viewport"/, `${path} is not responsive`);
      assert.match(html, /<title>[^<]{5,}<\/title>/, `${path} has no useful title`);
      assert.match(html, /<meta name="description" content="[^"]{20,}"/, `${path} has no description`);
      assert.equal((html.match(/<h1/g) ?? []).length, 1, `${path} does not have exactly one h1`);
      assert.match(html, /<main id="main">/, `${path} has no main landmark`);
      // No inline script or style: the product's CSP forbids both, and this is
      // exactly the class of bug that bit this codebase before.
      assert.doesNotMatch(html, /<script(?![^>]*src=)/, `${path} has an inline script`);
      assert.doesNotMatch(html, /\sstyle="/, `${path} has an inline style attribute`);
      // Decorative images are hidden from assistive technology.
      for (const image of html.match(/<img[^>]*>/g) ?? []) {
        assert.match(image, /alt="/, `${path} has an image with no alt attribute`);
      }
    }
  });

  it("SEO basics are served, and the private product is disallowed", async () => {
    const robots = await app.inject({ method: "GET", url: "/robots.txt" });
    assert.equal(robots.statusCode, 200);
    assert.match(robots.body, /Disallow: \/v1\//);
    assert.match(robots.body, /Sitemap: \/sitemap\.xml/);
    const sitemap = await app.inject({ method: "GET", url: "/sitemap.xml" });
    assert.equal(sitemap.statusCode, 200);
    assert.match(sitemap.body, /<loc>\/pricing<\/loc>/);
    assert.match(sitemap.body, /<loc>\/contact<\/loc>/);
    // The private surfaces are NOT advertised in the sitemap.
    assert.doesNotMatch(sitemap.body, /<loc>\/outcomes<\/loc>/);
  });

  /* ================================================== THE CORE REVEAL */

  it("scene eight is the memorable one, and says both things in words", async () => {
    const html = await page("/");
    assert.match(html, /ACTION VERIFIED/);
    assert.match(html, /OUTCOME UNSATISFIED/);
    assert.match(html, /The API call worked\. Reality still doesn&#39;t match|The API call worked/);
    assert.match(html, /Inherited team access = WRITE/);
    // And it is not colour alone: each claim carries its own words.
    assert.match(html, /class="claim claim-ok"/);
    assert.match(html, /class="claim claim-alarm"/);
  });

  /* ========================================================= PRICING */

  it("the pricing page renders exactly the canonical plans", async () => {
    const html = await page("/pricing");
    assert.match(html, new RegExp(PRICING_PROMISE.replace(/\./g, "\\.")));
    for (const item of PLANS) {
      assert.match(html, new RegExp(item.name), `${item.name} is missing from the pricing page`);
      assert.match(html, new RegExp(item.price.replace(/\$/g, "\\$").replace(/,/g, ",")),
        `${item.name}'s price is missing`);
      assert.match(html, new RegExp(item.cta.label), `${item.name}'s CTA is missing`);
    }
    assert.equal(plan("shadow_trial")!.price, "$0");
    assert.equal(plan("protect")!.price, "Starts at $1,500");
    assert.equal(plan("scale")!.price, "Starts at $4,500");
    assert.equal(plan("enterprise")!.price, "Custom annual pricing");
    // The trial says out loud that it cannot enforce.
    assert.match(html, /Shadow observes, it does not act/);
    // And no Stripe subscription anywhere.
    assert.doesNotMatch(html, /stripe|checkout|card number/i);
  });

  it("the pricing page states what a plan does NOT change", async () => {
    const html = await page("/pricing");
    assert.match(html, /never widen what an Agent is allowed to do/);
    assert.match(html, /does not disable your safety controls/);
    assert.match(html, new RegExp(ENTITLEMENT_DISCLAIMER.slice(0, 60)));
  });

  /* ==================================================== ENTITLEMENT */

  it("THE INVARIANT: entitlement can only ever refuse, and never touches safety", () => {
    for (const state of COMMERCIAL_STATES) {
      const entitlement = entitlementFor({ state: state as CommercialState });
      for (const feature of ["enforced_mode", "customer_relay"] as const) {
        const decision = mayEnable(entitlement, feature);
        // Two values. There is no third that grants anything.
        assert.ok(decision.decision === "allowed" || decision.decision === "refused");
        assert.ok(decision.reason.length > 10, "an entitlement decision with no usable reason");
      }
    }
    // A trial may not turn on Enforced production control.
    assert.equal(mayEnable(entitlementFor({ state: "trial" }), "enforced_mode").decision, "refused");
    // Enterprise gets everything.
    const enterprise = entitlementFor({ state: "enterprise" });
    assert.equal(mayEnable(enterprise, "self_hosted_deployment").decision, "allowed");

    // AND THE ONE THAT MATTERS: entitlement is not an input to authority.
    const authority = readFileSync(resolve(process.cwd(), "src/product/authority/canonicalAuthority.ts"), "utf8");
    assert.doesNotMatch(authority, /entitlement|commercial|plan_id|subscription/i,
      "THE AUTHORITY EVALUATOR CONSULTS COMMERCIAL STATE");
    const autonomy = readFileSync(resolve(process.cwd(), "src/product/authority/autonomyLine.ts"), "utf8");
    assert.doesNotMatch(autonomy, /entitlement|commercial|subscription/i);
    // And the entitlement module cannot REACH a safety mechanism: it imports
    // nothing from the product at all. It does mention Freeze and Blast Radius
    // in the customer-facing disclaimer, which is the opposite of a problem —
    // that sentence exists to say they are untouched.
    const entitlementSource = readFileSync(resolve(process.cwd(), "src/public/commercialEntitlement.ts"), "utf8");
    assert.doesNotMatch(entitlementSource, /^\s*import\b/m,
      "the entitlement module imports something; it must be a pure standalone decision");
    assert.match(ENTITLEMENT_DISCLAIMER, /Emergency Freeze, Blast Radius and Outcome requirements are identical on every plan/,
      "the disclaimer no longer states that safety is plan-independent");
    // The only two words it can return.
    const returned = [...entitlementSource.matchAll(/decision:\s*"(\w+)"/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(returned)].sort(), ["allowed", "refused"],
      "the entitlement decision has grown a third value");
  });

  it("an expired trial refuses new features and explicitly does not disable existing controls", () => {
    const expired = entitlementFor({ state: "trial", expires_at: new Date(Date.now() - 86_400_000).toISOString() });
    const decision = mayEnable(expired, "enforced_mode");
    assert.equal(decision.decision, "refused");
    assert.match(decision.reason, /Existing safety controls are unaffected/);
    assert.match(decision.reason, /freezes stay active/);
  });

  it("a design partner can be grandfathered by configuration, not by code", () => {
    const partner = entitlementFor({
      state: "trial", grandfathered: true, feature_overrides: ["enforced_mode", "canary_mode"],
    });
    assert.equal(partner.grandfathered, true);
    assert.equal(mayEnable(partner, "enforced_mode").decision, "allowed");
    // The override is additive only: it cannot remove a feature the plan has.
    const enterprise = entitlementFor({ state: "enterprise", feature_overrides: [] });
    assert.equal(mayEnable(enterprise, "customer_relay").decision, "allowed");
  });

  /* =================================================== CONFIGURATOR */

  it("the configurator works with no JavaScript at all", async () => {
    const html = await page("/configure");
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/configure"/);
    // Every step is a real fieldset in ONE form, so a single submit works.
    assert.ok((html.match(/<fieldset/g) ?? []).length >= 5, "the configurator is not built from real fieldsets");
    assert.equal((html.match(/<form/g) ?? []).length, 1, "the configurator is split across multiple forms");
    assert.match(html, /<legend>/);

    const submitted = await app.inject({
      method: "POST", url: "/configure",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "agents=3&consequential_actions_per_month=50000&environments=1&providers=github&providers=okta"
        + "&outcome_packs=employee_offboarding&deployment=nyst_cloud&identity=google"
        + "&company=Acme&email=buyer%40acme.test&notes=",
    });
    assert.equal(submitted.statusCode, 200);
    assert.match(submitted.body, /Protect/);
    assert.match(submitted.body, /Starts at \$1,500/);
  });

  it("the configurator recommends conservatively and names what would NOT be covered", () => {
    const base: QuoteInput = {
      agents: 3, consequential_actions_per_month: 50_000, environments: 1,
      providers: ["github", "okta"], outcome_packs: ["employee_offboarding"],
      deployment: "nyst_cloud", identity: "google", needs_security_review: false,
      company: "Acme", email: "buyer@acme.test", notes: "",
    };
    assert.equal(recommendPlan(base).recommended_plan, "protect");
    // Anything at or past an envelope boundary rolls UP rather than being
    // squeezed into the cheaper tier.
    assert.equal(recommendPlan({ ...base, agents: 6 }).recommended_plan, "scale");
    assert.equal(recommendPlan({ ...base, environments: 2 }).recommended_plan, "scale");
    assert.equal(recommendPlan({ ...base, agents: 40 }).recommended_plan, "enterprise");
    assert.equal(recommendPlan({ ...base, deployment: "self_hosted" }).recommended_plan, "enterprise");
    assert.equal(recommendPlan({ ...base, deployment: "relay" }).recommended_plan, "enterprise");
    assert.equal(recommendPlan({ ...base, needs_security_review: true }).recommended_plan, "enterprise");

    // Coverage honesty: an unsupported provider is named, not smoothed over.
    const withAws = recommendPlan({ ...base, providers: [...base.providers, "aws"] });
    assert.ok(withAws.uncovered.some((line) => /AWS/.test(line) && /INDETERMINATE/.test(line)),
      "the quote does not say what AWS being unconnected means");
    const withOther = recommendPlan({ ...base, providers: [...base.providers, "other"] });
    assert.ok(withOther.uncovered.some((line) => /no first-party integration/.test(line)));
    assert.equal(withOther.requires_conversation, true);
    // No Outcome Pack means Nyst is not establishing an outcome, and says so.
    assert.ok(recommendPlan({ ...base, outcome_packs: [] }).uncovered
      .some((line) => /will not establish an end-to-end outcome/.test(line)));
  });

  it("a contact submission is accepted, and a malformed one is refused rather than lost", async () => {
    const received: unknown[] = [];
    const recording = Fastify({ logger: false });
    registerPublicRoutes(recording, { record_contact: async (submission) => { received.push(submission); } });
    await recording.ready();
    try {
      const good = await recording.inject({
        method: "POST", url: "/contact",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "name=Buyer&email=buyer%40acme.test&company=Acme&topic=quote&message=We+want+to+talk",
      });
      assert.equal(good.statusCode, 200);
      assert.match(good.body, /Thank you — we have it/);
      assert.equal(received.length, 1);

      const bad = await recording.inject({
        method: "POST", url: "/contact",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "name=Buyer&email=&message=",
      });
      assert.equal(bad.statusCode, 400);
      assert.equal(received.length, 1, "an incomplete submission was recorded as if it were complete");
    } finally { await recording.close(); }
  });

  it("hostile input is escaped everywhere it is echoed back", async () => {
    const hostile = '"><script>alert(1)</script>';
    const submitted = await app.inject({
      method: "POST", url: "/configure",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `agents=3&consequential_actions_per_month=1000&environments=1&deployment=nyst_cloud`
        + `&identity=google&company=${encodeURIComponent(hostile)}&email=x%40y.test&notes=${encodeURIComponent(hostile)}`,
    });
    assert.equal(submitted.statusCode, 200);
    assert.doesNotMatch(submitted.body, /<script>alert\(1\)<\/script>/,
      "hostile input was rendered as markup");
    assert.match(submitted.body, /&lt;script&gt;/, "the hostile input was not echoed back escaped");
  });
});
