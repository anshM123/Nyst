/**
 * Nyst v0.3.2 — Phases 22, 23 and 24.
 *
 * PHASE 22. A provider that says "the change is not there" means two completely
 * different things depending on when you asked, and they demand opposite
 * answers: NOT_APPLIED, or PENDING and look again. Guessing wrong the second
 * way is the worst failure this system can have — not a refusal to answer, but
 * a confident false statement that access was not removed when it was.
 *
 * The fix is not `sleep(2000)`. A sleep is a guess about a provider's internals
 * encoded as a magic number that nobody can revisit, and it is wrong in both
 * directions at once. What replaces it is a DECLARATION per EffectSpec, which
 * is the kind of thing that can be measured later and corrected.
 *
 * PHASE 24. A 429 is information about the PROVIDER and none about the world.
 * Turning one into `not_applied` would let a rate limit produce a confident
 * false statement that the same read, retried a minute later, would contradict.
 *
 * These run with no database and no network.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  OBSERVATION_SEMANTICS, interpretContradiction, interpretProviderRefusal, observationSemantics,
} from "../src/product/observationSemantics.js";

const root = (() => {
  let candidate = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(candidate, "src/product/observationSemantics.ts"))) return candidate;
    candidate = join(candidate, "..");
  }
  throw new Error("could not locate the repository root");
})();

const GITHUB = "github.repository_permission_change";

describe("Nyst v0.3.2 Phases 22/24 — observation semantics", () => {

  /* ============================================ THE CONTRADICTION */

  it("THE DEFECT: an immediate contradictory read is PENDING, not NOT_APPLIED", async () => {
    // Nyst removed access one second ago and GitHub says the access is still
    // there. Calling that NOT_APPLIED would be a confident wrong answer.
    const verdict = interpretContradiction({ effect_name: GITHUB, elapsed_seconds: 1, observations: 1 });
    assert.equal(verdict.verdict, "pending",
      "AN IMMEDIATE CONTRADICTORY READ WAS TREATED AS EVIDENCE — a provider that had not caught up "
      + "would produce a confident false statement about a customer's access");
    assert.match(verdict.reason, /not evidence/i);
  });

  it("past the convergence window, REPEATED contradiction becomes evidence", () => {
    const semantics = observationSemantics(GITHUB)!;
    const verdict = interpretContradiction({
      effect_name: GITHUB,
      elapsed_seconds: semantics.convergence_window_seconds + 30,
      observations: 3,
    });
    assert.equal(verdict.verdict, "not_applied");
    assert.match(verdict.reason, /consistently/i);
  });

  it("ONE observation past the window is still not enough", () => {
    // A single read is a data point. The second costs one more request on a
    // question that is expensive to get wrong.
    const semantics = observationSemantics(GITHUB)!;
    const verdict = interpretContradiction({
      effect_name: GITHUB, elapsed_seconds: semantics.convergence_window_seconds + 30, observations: 1,
    });
    assert.equal(verdict.verdict, "pending");
  });

  it("past the reconciliation deadline Nyst STOPS and says it cannot tell", () => {
    // An outcome that is never resolved is worse than one honestly marked
    // unprovable, because it looks like work still in progress.
    const semantics = observationSemantics(GITHUB)!;
    const verdict = interpretContradiction({
      effect_name: GITHUB,
      elapsed_seconds: semantics.reconciliation_deadline_seconds + 1,
      observations: 50,
    });
    assert.equal(verdict.verdict, "unprovable");
    assert.match(verdict.reason, /cannot establish|never converged/i);
  });

  it("an UNCHARACTERISED effect gets the most conservative answer, not a guess", () => {
    const verdict = interpretContradiction({
      effect_name: "some.provider.effect_nobody_measured", elapsed_seconds: 5, observations: 9,
    });
    assert.equal(verdict.verdict, "unprovable",
      "an effect with no declared semantics was given a confident verdict");
    assert.match(verdict.reason, /will not guess/i);
  });

  /* ================================================ PHASE 24: REFUSAL */

  it("THE RULE: a 429 is NEVER evidence about the world", () => {
    const verdict = interpretProviderRefusal({ effect_name: GITHUB, status: 429, retry_after_seconds: 30 });
    assert.equal(verdict.verdict, "pending",
      "A RATE LIMIT BECAME A STATEMENT ABOUT WHETHER THE EFFECT HAPPENED");
    assert.match(verdict.reason, /NOTHING about whether/);
    assert.equal(verdict.observe_again_after_seconds, 30, "the provider's Retry-After was ignored");
  });

  it("a 500, a timeout and an unreachable provider are all the same answer", () => {
    for (const status of [500, 502, 503, null]) {
      const verdict = interpretProviderRefusal({ effect_name: GITHUB, status, retry_after_seconds: null });
      assert.equal(verdict.verdict, "pending", `status ${status} produced a verdict about the world`);
    }
  });

  it("Retry-After is honoured, floored, and bounded", () => {
    const semantics = observationSemantics(GITHUB)!;
    // Sooner than the floor would turn a rate limit into an outage.
    assert.equal(
      interpretProviderRefusal({ effect_name: GITHUB, status: 429, retry_after_seconds: 0 }).observe_again_after_seconds,
      semantics.minimum_observation_interval_seconds);
    // And a provider asking for a week does not park a job for a week.
    assert.equal(
      interpretProviderRefusal({ effect_name: GITHUB, status: 429, retry_after_seconds: 999_999 }).observe_again_after_seconds,
      3600);
  });

  /* =============================================== THE DECLARATIONS */

  it("every declared window is internally coherent", () => {
    for (const semantics of OBSERVATION_SEMANTICS) {
      assert.ok(semantics.convergence_window_seconds > 0, `${semantics.effect_name} has no convergence window`);
      assert.ok(
        semantics.reconciliation_deadline_seconds > semantics.convergence_window_seconds,
        `${semantics.effect_name} would give up before it finished converging`);
      assert.ok(
        semantics.minimum_observation_interval_seconds < semantics.convergence_window_seconds,
        `${semantics.effect_name} would observe less often than it converges`);
      assert.ok(semantics.rationale.length > 60,
        `${semantics.effect_name} has no rationale anyone could revisit`);
    }
  });

  it("EVERY window is marked DECLARED, NOT MEASURED — because none has been", () => {
    // The moment one is measured against a live provider, this test fails and
    // whoever measured it updates the claim deliberately rather than letting a
    // guess quietly acquire the status of a fact.
    for (const semantics of OBSERVATION_SEMANTICS) {
      assert.equal(semantics.measured_at, null,
        `${semantics.effect_name} claims a measured_at. If it really was measured against a live provider, `
        + "update this test and VERIFICATION.md — the number is now a fact rather than an expectation.");
      assert.match(semantics.rationale, /DECLARED, NOT MEASURED/,
        `${semantics.effect_name} does not say its window is an expectation rather than a measurement`);
    }
  });

  it("STRUCTURAL: no sleep constant stands in for these semantics", () => {
    // The thing this module exists to replace. A magic sleep in a provider or
    // worker is a guess nobody can revisit, and it would silently override
    // everything declared here.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      if (file.includes("observationSemantics")) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/setTimeout\s*\(\s*[^,]+,\s*(\d{4,})\s*\)/g)) {
        // Four digits or more: a millisecond delay of a second or longer, which
        // is the shape of "wait for the provider to catch up".
        offenders.push(`${file.slice(root.length + 1)}: setTimeout(..., ${match[1]})`);
      }
    }
    assert.deepEqual(offenders, [],
      `a hard-coded delay is standing in for observation semantics:\n  ${offenders.join("\n  ")}`);
  });

  /* ============================================ PHASE 23: PAGINATION */

  it("PAGINATION: enumeration is bounded and never follows an untrusted URL", () => {
    // The dangerous shape is following a `Link: rel="next"` URL from a response
    // body or header without checking its host: a compromised or spoofed
    // response could walk Nyst's credential to an attacker's server.
    const client = readFileSync(join(root, "src/providers/github/githubClient.ts"), "utf8");

    assert.doesNotMatch(client, /fetch\(\s*(?:response|next|link)/i,
      "the client follows a pagination URL taken from a response — that URL is attacker-influenced");
    assert.match(client, /page\s*<=\s*\d+/,
      "collaborator enumeration has no page bound, so a hostile or huge repository could loop forever");
    assert.match(client, /per_page=100/,
      "enumeration does not request full pages, which multiplies the number of requests");
  });

  it("PAGINATION: exceeding the bound is an ERROR, not a silent truncation", () => {
    // Silently returning the first N is the worst option: Nyst would report a
    // complete picture of access built from an incomplete list, and a
    // collaborator on page 11 would be invisible.
    const client = readFileSync(join(root, "src/providers/github/githubClient.ts"), "utf8");
    assert.match(client, /exceeded the bounded pagination limit/,
      "pagination past the bound does not raise — a truncated list would be reported as complete");
  });
});

function sourceFiles(directory: string, found: string[] = []): string[] {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}
