/**
 * Nyst v0.3.0 — Phase 1C. Production packaging.
 *
 * The defect this exists to prevent, in full:
 *
 *   `pg` was declared only under devDependencies, with an OPTIONAL peer entry.
 *   Every entry point — the web host, the worker host, the migration runner —
 *   does `await import("pg")`. The Dockerfile's runtime stage runs
 *   `npm ci --omit=dev`. So the production image shipped without the one
 *   package it cannot start without, and the failure appears only when a
 *   container is actually run.
 *
 * A test that just asserts `"pg" in dependencies` would be a note-to-self.
 * This instead derives the requirement from the code: every bare module
 * specifier reachable from a production entry point must be satisfiable by the
 * production dependency closure. Add a new import of a dev-only package
 * tomorrow and this fails immediately, in CI, rather than in a container.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  version: string;
};

const production = new Set(Object.keys(manifest.dependencies ?? {}));
const development = new Set(Object.keys(manifest.devDependencies ?? {}));

/** Every .ts file under a directory, recursively. */
function sources(directory: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(resolve(root, directory));
  return out;
}

/** Bare package specifiers — not relative paths, not node: builtins. */
function bareImports(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g,   // static
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,                     // dynamic
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,                    // interop
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      // A scoped package is @scope/name; a plain one is just name.
      found.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
    }
  }
  return [...found];
}

describe("Phase 1C — the production dependency closure can actually run the product", () => {
  it("pg is a production dependency, not a dev or optional-peer one", () => {
    // Stated explicitly as well as derived, because this specific package is
    // the one that broke, and the failure mode is a container that will not boot.
    assert.ok(production.has("pg"),
      "pg is imported by the web host, the worker host and the migration runner. " +
      "Under `npm ci --omit=dev` it must still be installed.");
    assert.ok(!development.has("pg"), "pg must not ALSO be a devDependency");
    assert.equal(manifest.peerDependencies?.pg, undefined,
      "pg as an optional peer made a required runtime package look optional");
    assert.equal(manifest.peerDependenciesMeta?.pg?.optional, undefined);
  });

  it("every package the runtime imports is in dependencies, not devDependencies", () => {
    const entryPoints = [
      ...sources("src"),
      // The scripts a production container actually executes.
      "scripts/startProduct.ts", "scripts/startWorker.ts", "scripts/migrate.ts",
    ].map((path) => resolve(root, path));

    const missing: string[] = [];
    for (const file of entryPoints) {
      for (const specifier of bareImports(file)) {
        if (production.has(specifier)) continue;
        const relative = file.slice(root.length + 1).replace(/\\/g, "/");
        missing.push(`${relative} imports "${specifier}" (${development.has(specifier) ? "devDependency only" : "not declared at all"})`);
      }
    }
    assert.deepEqual(missing, [],
      "these imports cannot be resolved in a production install:\n  " + missing.join("\n  "));
  });

  it("dev-only tooling has not leaked into the production closure", () => {
    // The other direction: shipping TypeScript into a runtime image is pure
    // attack surface, and it is the usual consequence of over-correcting.
    for (const tool of ["typescript", "@types/node"]) {
      assert.ok(!production.has(tool), `${tool} must not be a production dependency`);
    }
  });

  it("the SDK carries no runtime dependency of its own", () => {
    const sdk = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(sdk.dependencies, undefined);
    assert.equal(sdk.peerDependencies, undefined);
  });
});

describe("Phase 1I — version truth", () => {
  const files: ReadonlyArray<readonly [string, string]> = [
    ["package.json", manifest.version],
    ["packages/sdk/package.json", (JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")) as { version: string }).version],
  ];

  for (const [name, version] of files) {
    it(`${name} declares 0.3.1`, () => {
      assert.equal(version, "0.3.1");
    });
  }

  it("the server reports the same version it was built as", async () => {
    const { NYST_VERSION } = await import("../src/product/server.js");
    assert.equal(NYST_VERSION, manifest.version,
      "the running service and its manifest must not disagree about what it is");
  });
});
