/**
 * Nyst v0.3.1 — the configuration template must not fall behind the code.
 *
 * `.env.example` had drifted. It listed `NYST_OKTA_ORG_URL` and
 * `NYST_STRIPE_API_KEY` as though they were the whole Okta and Stripe story,
 * and it did not mention a single variable v0.3.1 added — so anyone setting up
 * a deployment from it would have missed Google Sign-In entirely and never
 * known the contact address was configurable.
 *
 * A setup template with the wrong names in it is worse than no template: it
 * looks authoritative, and the failure it produces is "I set that and nothing
 * happened."
 *
 * So the template is checked against what the code actually reads. This runs
 * with no database and no network.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = (() => {
  let candidate = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(candidate, ".env.example"))) return candidate;
    candidate = join(candidate, "..");
  }
  throw new Error("could not locate the repository root");
})();

const template = readFileSync(join(root, ".env.example"), "utf8");

/**
 * Variables no static scan can see, with the reason each is genuinely invisible.
 *
 * Kept deliberately short. Every entry here is a place where the code cannot be
 * checked, so the bar is "the indirection is real", not "the test is annoying".
 */
const RESOLVED_DYNAMICALLY = new Map([
  ["DATABASE_URL", "read through the pg connection string, not by name"],
  ["NODE_ENV", "read by Node and by config.ts as a mode, not as configuration"],
  ["NYST_SMTP_PASSWORD",
    "named by the VALUE of NYST_SMTP_PASSWORD_REF and resolved through the "
    + "SecretProvider at send time, exactly like the Google client secret below. "
    + "The operator picks the name; the template only shows the conventional one."],
  ["NYST_GOOGLE_CLIENT_SECRET",
    "named by the VALUE of NYST_GOOGLE_CLIENT_SECRET_REF and resolved through "
    + "the SecretProvider at the moment of use. The operator chooses the name; "
    + "this is only the conventional default, which is why no source file "
    + "mentions it."],
]);

/** Every source file the running product is built from. */
function sourceFiles(directory: string, found: string[] = []): string[] {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Every NYST_ or OUTCOME_ variable read anywhere in src, scripts or api. */
function variablesReadByCode(): Set<string> {
  const names = new Set<string>();
  for (const directory of ["src", "scripts", "api"]) {
    for (const file of sourceFiles(join(root, directory))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\benv\.((?:NYST|OUTCOME)_[A-Z0-9_]+)/g)) names.add(match[1]!);
      for (const match of text.matchAll(/process\.env\.((?:NYST|OUTCOME)_[A-Z0-9_]+)/g)) names.add(match[1]!);
      // A variable named inside an `env:NAME` REFERENCE is read too —
      // EnvSecretProvider resolves it at the moment of use, so it never appears
      // as `process.env.NAME` anywhere. NYST_GOOGLE_CLIENT_SECRET is exactly
      // that: the code reads NYST_GOOGLE_CLIENT_SECRET_REF, whose VALUE names it.
      for (const match of text.matchAll(/env:((?:NYST|OUTCOME)_[A-Z0-9_]+)/g)) names.add(match[1]!);
    }
  }
  return names;
}

describe("Nyst v0.3.1 — .env.example matches the code", () => {

  it("every variable the code reads appears in the template", () => {
    const missing = [...variablesReadByCode()]
      .filter((name) => !new RegExp(`^\\s*#?\\s*${name}=`, "m").test(template))
      .sort();
    assert.deepEqual(missing, [],
      "these variables are read by the code and absent from .env.example, so nobody setting up "
      + `a deployment would know they exist:\n  ${missing.join("\n  ")}`);
  });

  it("every variable the template declares is actually read by the code", () => {
    // The other direction matters too: a template entry nothing reads is a
    // setting someone will configure and then wonder why it does nothing.
    const read = variablesReadByCode();
    const declared = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
    const orphaned = declared.filter((name) =>
      !read.has(name) && !RESOLVED_DYNAMICALLY.has(name));
    assert.deepEqual(orphaned, [],
      `the template declares variables nothing reads: ${orphaned.join(", ")}`);
  });

  it("NO CREDENTIAL FIELD CARRIES A VALUE", () => {
    // The template ships in the deliverable. A filled-in one is the mistake it
    // exists to prevent.
    const filled: string[] = [];
    for (const [, name, value] of template.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      if (!/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|_KEY_B64|API_KEY|JWK)$/.test(name!)) continue;
      if (value!.trim().length > 0) filled.push(`${name}=${value}`);
    }
    assert.deepEqual(filled, [],
      `A CREDENTIAL FIELD IN .env.example HAS A VALUE:\n  ${filled.join("\n  ")}`);
  });

  it("the secret REFERENCE points at a variable, and is not itself a secret", () => {
    const reference = /^NYST_GOOGLE_CLIENT_SECRET_REF=(.*)$/m.exec(template);
    assert.ok(reference, "the template does not show how to reference the Google client secret");
    assert.match(reference[1]!.trim(), /^env:[A-Z][A-Z0-9_]*$/,
      "the example reference is not the NAME of a variable — which is the one thing it has to demonstrate");
  });

  /* --------------------------------------------------- the setup document */

  it("OWNER-SETUP.md names only variables that exist", () => {
    // This document is handed to whoever configures the deployment. A wrong
    // name there produces "I set that and nothing happened", which is the
    // hardest kind of misconfiguration to diagnose.
    const document = readFileSync(join(root, "docs/OWNER-SETUP.md"), "utf8");
    const read = variablesReadByCode();
    const wrong = [...new Set([...document.matchAll(/\b((?:NYST|OUTCOME)_[A-Z0-9_]{3,})\b/g)]
      .map((match) => match[1]!))]
      .filter((name) => !read.has(name) && !RESOLVED_DYNAMICALLY.has(name))
      .sort();
    assert.deepEqual(wrong, [],
      `docs/OWNER-SETUP.md names variables the code never reads:\n  ${wrong.join("\n  ")}`);
  });

  /**
   * A REFERENCE MUST NAME THE VARIABLE ITS PROVIDER ACTUALLY READS.
   *
   * Stripe's declared reference was `env:NYST_STRIPE_CREDENTIAL` — the one an
   * operator has to store, because admission refuses anything else — while its
   * credential source read `process.env.NYST_STRIPE_API_KEY`. Following the
   * documented reference therefore produced an integration that passed
   * admission and then failed to resolve at execution.
   *
   * GitHub and Okta were already consistent. This asserts the property for all
   * of them, so a fourth provider cannot reintroduce it.
   */
  it("every provider's expected reference names the variable its credential source reads", () => {
    const repository = readFileSync(join(root, "src/product/productRepository.ts"), "utf8");
    const block = /EXPECTED_PROVIDER_REFS[^=]*=\s*\{([^}]*)\}/.exec(repository);
    assert.ok(block, "EXPECTED_PROVIDER_REFS could not be located");

    const expected = [...block[1]!.matchAll(/(\w+)\s*:\s*"env:([A-Z0-9_]+)"/g)]
      .map((match) => ({ provider: match[1]!, variable: match[2]! }));
    assert.ok(expected.length >= 3, `only ${expected.length} providers found`);

    const wrong: string[] = [];
    for (const { provider, variable } of expected) {
      const source = join(root, "src/providers", provider, "types.ts");
      if (!existsSync(source)) continue;
      const text = readFileSync(source, "utf8");
      // The credential source must read exactly the variable the reference
      // names. A comment mentioning another name is fine; a read is not.
      const reads = [...text.matchAll(/process\.env\.(NYST_[A-Z0-9_]+)/g)].map((match) => match[1]!);
      if (reads.length && !reads.includes(variable)) {
        wrong.push(`${provider}: reference names ${variable}, source reads ${[...new Set(reads)].join(", ")}`);
      }
    }
    assert.deepEqual(wrong, [],
      `A DOCUMENTED CREDENTIAL REFERENCE DOES NOT NAME THE VARIABLE THE PROVIDER READS:\n  ${wrong.join("\n  ")}`);
  });

  it("BACKEND-HANDOFF.md names only variables that exist", () => {
    const document = readFileSync(join(root, "docs/BACKEND-HANDOFF.md"), "utf8");
    const read = variablesReadByCode();
    const wrong = [...new Set([...document.matchAll(/\b((?:NYST|OUTCOME)_[A-Z0-9_]{3,})\b/g)]
      .map((match) => match[1]!))]
      .filter((name) => !read.has(name) && !RESOLVED_DYNAMICALLY.has(name))
      .sort();
    assert.deepEqual(wrong, [], `docs/BACKEND-HANDOFF.md names variables the code never reads:\n  ${wrong.join("\n  ")}`);
  });
});
