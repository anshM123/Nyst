/**
 * Phase 24 — navigation, session controls, and CSP-safe styling.
 *
 * These are regression tests for three defects that browser QA found and that
 * nothing else in the suite would have caught, because each one is a property
 * of the SHELL rather than of any single page:
 *
 *   1. There was no way back to the home page by clicking the brand mark.
 *   2. There was no sign-out control at all, so a browser session could not be
 *      ended from the browser even though /v1/auth/logout existed.
 *   3. Content-Security-Policy is `style-src 'self'`, so every inline style=""
 *      attribute was silently dropped by the browser. Forty-four of them.
 *
 * The third is the one worth guarding hardest: a blocked inline style produces
 * no error the server ever sees and no visible failure in a test that only
 * looks at markup. It has to be asserted directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actionsPage, agentsPage, effectRegistryPage, failureLabPage, genericPage, integrationsPage,
  needsAttentionPage, offboardingPage, onboardingPage, overviewPage, policiesPage,
  receiptsPage, reviewsPage, settingsPage, type ShellContext,
} from "../src/product/dashboard.js";
import { APP_JS, APP_CSS } from "../src/product/assets.js";
import type { CanonicalMetrics } from "../src/product/canonicalMetrics.js";

const METRICS: CanonicalMetrics = {
  mode: "enforced",
  range: { label: "all", from: "1970-01-01T00:00:00.000Z", to: "2026-08-11T00:00:00.000Z", sql_upper_bound: null },
  consequential_actions: 0, ambiguous_executions: 0,
  unsafe_retries_prevented_enforced: 0, unsafe_retries_detected_shadow: 0,
  unsafe_continuations_prevented_enforced: 0, unsafe_continuations_detected_shadow: 0,
  auto_resolved: 0, human_escalations: 0, median_reconciliation_duration_ms: null,
  recent_interventions: [], provider_breakdown: {}, effect_breakdown: {}, agent_breakdown: {},
  metric_definitions: {},
};

const CONTEXT: ShellContext = {
  attention: 2, project: "Corporate IT", environment: "Production", mode: "enforced", frozen: null,
  projects: [{
    project_id: "11111111-1111-4111-8111-111111111111", project_name: "Corporate IT",
    environments: [
      { environment_id: "22222222-2222-4222-8222-222222222222", environment_name: "Production" },
      { environment_id: "33333333-3333-4333-8333-333333333333", environment_name: "Staging" },
    ],
  }],
  selected_project_id: "11111111-1111-4111-8111-111111111111",
  selected_environment_id: "22222222-2222-4222-8222-222222222222",
};

/** Every surface that renders inside the application shell. */
const SHELL_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["overview", overviewPage(METRICS, CONTEXT)],
  ["needs-attention", needsAttentionPage([], CONTEXT)],
  ["agents", agentsPage([], CONTEXT)],
  ["actions", actionsPage([], "Actions", {}, CONTEXT)],
  ["policies", policiesPage([], CONTEXT)],
  ["effect-registry", effectRegistryPage([], CONTEXT)],
  ["failure-lab", failureLabPage([], { mode: "enforced", is_demo: false }, CONTEXT)],
  ["integrations", integrationsPage([], [], CONTEXT)],
  ["reviews", reviewsPage([], CONTEXT)],
  ["receipts", receiptsPage([], CONTEXT)],
  ["offboarding", offboardingPage([], CONTEXT)],
  ["onboarding", onboardingPage({}, [], CONTEXT)],
  ["settings", settingsPage(
    { organization: "Northwind", project: "Corporate IT", environment: "Production" },
    { mode: "enforced" }, [], [], { active: [] }, CONTEXT)],
  ["generic", genericPage("Title", "Body")],
];

describe("Phase 24 — getting home", () => {
  for (const [name, html] of SHELL_PAGES) {
    if (name === "generic") continue;
    it(`${name} makes the brand mark a real link to the home page`, () => {
      assert.match(html, /<a class="brand" href="\/"/,
        "clicking the product mark to get home is the one navigation convention every person already has");
      assert.match(html, /aria-label="Nyst[^"]*Overview"/,
        "the brand link needs an accessible name; its only visible text is a logo");
    });

    it(`${name} keeps a home link that survives a narrow viewport`, () => {
      // The sidebar becomes a horizontally scrolling rail below 900px, so the
      // "Overview" item in it can sit off-screen. The topbar link cannot.
      assert.match(html, /<a class="topbar-home" href="\/">Overview<\/a>/);
    });
  }
});

describe("Phase 24 — ending a session", () => {
  for (const [name, html] of SHELL_PAGES) {
    if (name === "generic") continue;
    it(`${name} offers a sign-out control`, () => {
      assert.match(html, /data-signout="true"/);
      assert.match(html, /Sign out/);
    });
  }

  it("sign-out is wired to the server, not to a client-side illusion", () => {
    assert.match(APP_JS, /dataset\.signout/);
    assert.match(APP_JS, /"POST",\s*"\/v1\/auth\/logout"/,
      "the session cookie is httpOnly; only the server can revoke the session");
    assert.match(APP_JS, /sessionStorage\.removeItem\("nyst_csrf"\)/);
    assert.match(APP_JS, /location\.href = "\/login"/);
  });
});

describe("Phase 24 — no control that cannot work", () => {
  it("the project/environment switcher goes through the client script", () => {
    // It posts to a JSON + CSRF endpoint. A native form POST there can only
    // ever be refused, which is the definition of a dead control.
    assert.match(APP_JS, /getElementById\("nyst-project-context"\)/);
    assert.match(APP_JS, /"POST",\s*"\/v1\/context"/);
    assert.match(APP_JS, /preventDefault/);
  });

  it("the switcher cannot express a project/environment pair that does not exist", () => {
    const html = overviewPage(METRICS, CONTEXT);
    const switcher = html.slice(html.indexOf('id="nyst-project-context"'), html.indexOf("</form>"));
    assert.equal((switcher.match(/<select/g) ?? []).length, 1,
      "two independent selects let a person choose a pair the server can only 404 on");
    // Each option carries the pair together.
    assert.match(switcher, /value="11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"/);
    assert.match(switcher, /value="11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333"/);
  });

  it("the switcher select is still labelled", () => {
    const html = overviewPage(METRICS, CONTEXT);
    assert.match(html, /<label class="visually-hidden" for="nyst-project">/);
    assert.match(html, /id="nyst-project"/);
  });
});

describe("Phase 24 — Content-Security-Policy safe styling", () => {
  // style-src 'self' blocks inline style attributes outright. A style="" that
  // reaches the browser is not "slightly wrong", it is absent.
  for (const [name, html] of SHELL_PAGES) {
    it(`${name} carries no inline style attribute`, () => {
      const found = html.match(/ style="[^"]*"/g);
      assert.equal(found, null,
        `style-src 'self' would silently drop: ${JSON.stringify(found?.slice(0, 3))}`);
    });
  }

  it("the client script styles by class, never by inline style", () => {
    assert.doesNotMatch(APP_JS, /\.style\.cssText/);
    assert.doesNotMatch(APP_JS, /\.style\.[a-zA-Z]+\s*=/);
    assert.match(APP_JS, /className = "note"/);
  });

  it("every utility class the markup uses is actually defined in the stylesheet", () => {
    const used = new Set<string>();
    for (const [, html] of SHELL_PAGES) {
      for (const attribute of html.match(/class="[^"]*"/g) ?? []) {
        for (const token of attribute.slice(7, -1).trim().split(/\s+/)) if (token) used.add(token);
      }
    }
    assert.ok(!used.has("undefined"), 'a page rendered the literal class "undefined"');
    const missing = [...used].filter((token) => !new RegExp(`\\.${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(APP_CSS));
    assert.deepEqual(missing, [],
      "a class with no rule behind it is the same silent failure as an inline style");
  });

  it("the root element does not clip horizontal overflow", () => {
    // Clipping would make a real layout overflow invisible rather than absent,
    // and the far half of a wide table would simply be unreachable on a phone.
    const css = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const root = css.slice(css.indexOf("html {"), css.indexOf("}", css.indexOf("html {")));
    assert.doesNotMatch(root, /overflow-x:\s*hidden/);
    // Wide content scrolls inside its own container instead.
    assert.match(APP_CSS, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(APP_CSS, /\.table-scroll\s*>\s*table\s*\{[^}]*min-width:\s*max-content/);
  });
});
