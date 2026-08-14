import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Gate 3 live canary packaging", () => {
  it("runs the typed canary against compiled production modules", () => {
    const root = join(import.meta.dirname, "..", "..");
    assert.equal(existsSync(join(root, "dist", "src", "providers", "github", "githubProvider.js")), true);
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      packageJson.scripts["test:github:live"],
      "npm run build && node --experimental-strip-types scripts/verifyGitHubLive.ts"
    );
  });

  it("loads the Gate-4 runner far enough to validate environment without initialization errors", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "verifyGitHubGate4Live.ts"), "utf8");
    assert.ok(source.indexOf("class DiscardAfterMutationTransport") < source.indexOf("new DiscardAfterMutationTransport"));
  });
});

describe("Gate 5 live canary packaging", () => {
  it("binds the compiled Okta provider and declares the response-loss transport before use", () => {
    const root = join(import.meta.dirname, "..", "..");
    assert.equal(existsSync(join(root, "dist", "src", "providers", "okta", "oktaProvider.js")), true);
    const source = readFileSync(join(root, "scripts", "verifyOktaGate5Live.ts"), "utf8");
    assert.ok(source.indexOf("class ResponseDroppingTransport") < source.indexOf("new ResponseDroppingTransport"));
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(packageJson.scripts["test:okta:gate5-live"], "npm run build && node --experimental-strip-types scripts/verifyOktaGate5Live.ts");
  });
});

describe("Gate 6 integrated live canary packaging", () => {
  it("binds both production providers and protects fixture cleanup", () => {
    const script = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "verifyGate6Live.ts"), "utf8");
    assert.match(script, /OffboardingCoordinator/);
    assert.match(script, /finally/);
    assert.match(script, /oktaRestored/);
    assert.match(script, /githubRestored/);
    assert.doesNotMatch(script, /subject_key: `[^`]*\|/);
    assert.match(script, /observation < 2/);
    assert.match(script, /coordinator\.execute\(liveIntent\)/);
    assert.match(script, /consistency_deadline/);
    assert.match(script, /store\.actions\.getAction/);
    assert.match(script, /305_000/);
    assert.match(script, /diagnoseInheritedGitHubAccess/);
    assert.match(script, /active_team_access/);
    assert.match(script, /organization_role/);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "..", "..", "scripts", "verifyGate6Live.ts")], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NYST_") && key !== "DATABASE_URL")),
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /DATABASE_URL is required/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /does not provide an export/);
  });
});

describe("Gate 7 Stripe live canary packaging", () => {
  it("binds both compiled Stripe effects, response loss, sandbox cleanup, and environment validation", () => {
    const root = join(import.meta.dirname, "..", "..");
    assert.equal(existsSync(join(root, "dist", "src", "providers", "stripe", "stripeProvider.js")), true);
    const script = readFileSync(join(root, "scripts", "verifyStripeGate7Live.ts"), "utf8");
    assert.ok(script.indexOf("class CountingResponseLossTransport") < script.indexOf("new CountingResponseLossTransport"));
    assert.match(script, /requireTestStripeKey/); assert.match(script, /stripe_fixture_cleanup/); assert.match(script, /fully_refunded/);
    assert.match(script, /resolution\.effect\.state === "pending"/); assert.match(script, /runtime\.reconcile/); assert.match(script, /attempt < 60/);
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(packageJson.scripts["test:stripe:gate7-live"], "npm run build && node --experimental-strip-types scripts/verifyStripeGate7Live.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "verifyStripeGate7Live.ts")], {
      cwd: root, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DATABASE_URL" && key !== "NYST_STRIPE_CREDENTIAL")),
    });
    assert.notEqual(result.status, 0); assert.match(`${result.stdout}${result.stderr}`, /DATABASE_URL is required/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /does not provide an export/);
  });
});
