/**
 * Nyst v0.3.1 — issue 13. THE PRODUCTION CONTAINER IMAGE.
 *
 * WHAT THIS FILE DOES AND DOES NOT ESTABLISH.
 *
 * It does NOT establish that the image builds. Docker is not installed in this
 * environment, so `docker build` was never run and no such claim is made
 * anywhere in this release. See RELEASE.md: **NOT INDEPENDENTLY VERIFIED —
 * DOCKER IMAGE NOT BUILT.**
 *
 * What it DOES establish is everything about the Dockerfile that can be checked
 * without a daemon, which is more than it sounds:
 *
 *   - every path the Dockerfile COPYs actually exists in the repository
 *   - every npm script it runs actually exists in package.json
 *   - the three documented entrypoints are real files
 *   - the entrypoint command form is exec, so SIGTERM reaches PID 1
 *   - the image does not run as root and bakes in no secret
 *
 * A `COPY public ./public` for a directory that was renamed fails the build
 * minutes in, and that is the class of defect a build would have caught. This
 * catches it in milliseconds instead. It is not a substitute for building the
 * image; it is the part of the verification that does not need one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The repository root, found by walking up to the Dockerfile.
 *
 * Not `join(import.meta.dirname, "..")`: this suite runs both from `tests/` via
 * tsx and from `dist/tests/` after a build, and that expression resolves to
 * `dist/` in the second case — where there is no Dockerfile, so every check
 * would fail for a reason that has nothing to do with the image.
 */
const root = (() => {
  let candidate = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(candidate, "Dockerfile"))) return candidate;
    candidate = join(candidate, "..");
  }
  throw new Error("could not locate the repository root from " + import.meta.dirname);
})();
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

/** Every COPY in the Dockerfile, as (sources, destination). */
function copyDirectives(): { sources: string[]; destination: string; line: string }[] {
  return dockerfile.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^COPY\b/.test(line))
    .map((line) => {
      // Drop the COPY keyword and any --flag=value.
      const parts = line.replace(/^COPY\s+/, "").split(/\s+/).filter((part) => !part.startsWith("--"));
      return { sources: parts.slice(0, -1), destination: parts[parts.length - 1]!, line };
    });
}

describe("Nyst v0.3.1 issue 13 — the production container image", () => {

  it("DOCKER IS NOT AVAILABLE HERE, and this file says so rather than implying otherwise", () => {
    // The point of asserting this is that if Docker ever DOES become available,
    // this test fails and whoever sees it is told to run the real build rather
    // than continuing to rely on static checks.
    let available = true;
    try {
      execFileSync("docker", ["version"], { stdio: "ignore" });
    } catch { available = false; }

    assert.equal(available, false,
      "Docker is now available in this environment. Run `docker build -t nyst:local .` and "
      + "`docker run` the three roles, then replace the NOT INDEPENDENTLY VERIFIED note in RELEASE.md "
      + "with the real result. Static checks are not a substitute for a build.");
  });

  /* ==================================================== COPY SOURCES EXIST */

  it("every path the Dockerfile COPYs exists in the repository", () => {
    const missing: string[] = [];
    for (const directive of copyDirectives()) {
      for (const source of directive.sources) {
        // Build-stage copies come from the previous stage, not the context.
        if (directive.line.includes("--from=")) continue;
        if (!existsSync(join(root, source))) missing.push(`${source}  (${directive.line})`);
      }
    }
    assert.deepEqual(missing, [],
      `THE IMAGE BUILD WOULD FAIL: these COPY sources do not exist:\n  ${missing.join("\n  ")}`);
  });

  it("every artifact copied from the build stage is something the build actually produces", () => {
    // `COPY --from=build /app/dist` only works if `npm run build` emitted dist.
    const fromBuild = copyDirectives()
      .filter((directive) => directive.line.includes("--from=build"))
      .flatMap((directive) => directive.sources)
      .map((source) => source.replace(/^\/app\//, ""));

    assert.ok(fromBuild.length > 0, "no artifacts are copied out of the build stage");
    for (const artifact of fromBuild) {
      // node_modules is installed rather than emitted; the rest must be built.
      if (artifact.startsWith("node_modules")) continue;
      assert.ok(existsSync(join(root, artifact)),
        `the image copies ${artifact} out of the build stage, but a local build has not produced it — `
        + "run `npm run build` and confirm the output path matches");
    }
  });

  /* ======================================================== ENTRYPOINTS */

  it("the three documented roles are real files that exist", () => {
    // The header comment promises web, worker and migrate. A documented role
    // pointing at a deleted script is a container that crash-loops on start.
    const documented = [...dockerfile.matchAll(/scripts\/[A-Za-z0-9_.-]+\.ts/g)].map((match) => match[0]);
    assert.ok(documented.length >= 3, `only ${documented.length} script references found in the Dockerfile`);
    for (const script of new Set(documented)) {
      assert.ok(existsSync(join(root, script)), `the Dockerfile references ${script}, which does not exist`);
    }
  });

  it("every npm script the Dockerfile runs exists in package.json", () => {
    const invoked = [...dockerfile.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]!);
    assert.ok(invoked.length > 0, "the Dockerfile runs no npm scripts, which is unexpected");
    for (const script of new Set(invoked)) {
      assert.ok(packageJson.scripts?.[script],
        `the Dockerfile runs "npm run ${script}", which package.json does not define`);
    }
  });

  it("CMD is exec form, so SIGTERM reaches PID 1 and shutdown handlers run", () => {
    // Shell form wraps the process in /bin/sh, which does not forward signals.
    // The graceful shutdown in startProduct.ts would then never fire, and the
    // orchestrator would SIGKILL mid-request after the grace period.
    const cmd = /^CMD\s+(.+)$/m.exec(dockerfile);
    assert.ok(cmd, "the Dockerfile has no CMD");
    assert.match(cmd[1]!.trim(), /^\[.*\]$/,
      "CMD is in shell form; SIGTERM would go to /bin/sh and the shutdown handlers would never run");
  });

  /* ========================================================== POSTURE */

  it("the image does not run as root", () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]!);
    assert.ok(users.length > 0, "the Dockerfile never drops from root");
    assert.notEqual(users[users.length - 1], "root", "the final USER is root");
  });

  it("no secret, credential or connection string is baked into the image", () => {
    // ENV in a Dockerfile is baked into the image and visible to anyone who can
    // pull it. Configuration arrives at runtime; credentials arrive as
    // references resolved through the SecretProvider.
    const envLines = [...dockerfile.matchAll(/^\s*ENV\s+(.+)$/gm)].map((match) => match[1]!);
    for (const line of envLines) {
      assert.doesNotMatch(line, /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY)\s*=\s*\S/i,
        `a credential-shaped value is baked into the image: ${line}`);
    }
    assert.doesNotMatch(dockerfile, /postgres:\/\/[^\s"']*:[^\s"'@]+@/,
      "a connection string with a password is present in the Dockerfile");
  });

  it("the runtime stage does not ship the build toolchain", () => {
    // `npm ci --omit=dev` before the runtime copy is what keeps TypeScript and
    // the test runner out of the image. Every tool left behind is attack
    // surface in a container that only ever needs to run one process.
    assert.match(dockerfile, /npm ci --omit=dev/,
      "the image ships development dependencies into the runtime stage");
  });

  it("HEALTHCHECK probes liveness, not readiness", () => {
    // A container healthcheck that hits /ready restarts the process during a
    // database blip, turning a recoverable outage into a restart storm. Taking
    // an instance out of the load-balancer pool is the orchestrator's job.
    const healthcheck = /HEALTHCHECK[\s\S]*?CMD\s+(.+)/.exec(dockerfile);
    assert.ok(healthcheck, "the image has no HEALTHCHECK");
    assert.match(healthcheck[1]!, /\/health/, "the healthcheck does not probe /health");
    assert.doesNotMatch(healthcheck[1]!, /\/ready/,
      "the CONTAINER healthcheck probes /ready — a database blip would restart a healthy process");
  });

  /* ==================================================== COMPOSE AGREEMENT */

  it("docker-compose agrees with the Dockerfile about the exposed port", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const exposed = /^EXPOSE\s+(\d+)/m.exec(dockerfile);
    assert.ok(exposed, "the Dockerfile exposes no port");
    assert.ok(compose.includes(exposed[1]!),
      `the Dockerfile exposes ${exposed[1]} and docker-compose.yml never mentions it`);
  });
});
