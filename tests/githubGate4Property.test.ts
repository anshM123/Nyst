import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

describe("Gate 4 deterministic GitHub-shaped property sequences", () => {
  for (const seed of [4, 44, 404, 65_537, 20_260_807]) {
    it(`seed ${seed} preserves global safety invariants`, async () => {
      const random = mulberry32(seed);
      for (let step = 0; step < 20; step++) {
        const mode = Math.floor(random() * 6);
        const h = makeGitHubHarness({ role: mode === 4 ? "admin" : "read" });
        let desired: "read" | "write" = "write";
        switch (mode) {
          case 0:
            h.transport.responseLossAfterEffect = true;
            break;
          case 1:
            h.transport.failMayHaveBeenSentBeforeEffect = true;
            break;
          case 2:
            h.transport.successfulResponseWithoutEffect = true;
            break;
          case 3:
            h.transport.postMutationReads = ["read", "read", "write"];
            break;
          case 4:
            desired = "read";
            h.transport.inheritedRoleAfterSet = "write";
            break;
          case 5:
            h.transport.beforeMutation = () => { h.transport.malformedPermissionResponse = true; };
            break;
        }

        const first = await h.service.commit(`g4-property:${seed}:${step}`, githubInput(desired), EMPTY_CONTEXT);
        let latest = first.resolution;
        if (latest.effect.state === "pending" && random() > 0.35) {
          if (mode === 2 || mode === 4) h.clock.advance(6 * 60_000);
          latest = await h.runtime.reconcile(first.action.action_id);
        }

        assert.ok(h.transport.mutationCount <= 1, `seed=${seed} step=${step} duplicate write`);
        assert.notEqual(latest.effect.state, "verified", `seed=${seed} step=${step} false attribution`);
        if (latest.effect.state === "pending" || latest.effect.state === "unprovable" || latest.effect.state === "not_applied") {
          assert.equal(latest.control.continuation, "blocked", `seed=${seed} step=${step} unsafe continuation`);
        }
        if (latest.effect.state === "pending" || latest.effect.state === "unprovable") {
          assert.notEqual(latest.control.retry, "allowed", `seed=${seed} step=${step} unsafe retry`);
        }
        assert.equal(verifyResolution(h.signer, latest), true, `seed=${seed} step=${step} bad signature`);
        const action = await h.store.actions.findByIdentity(h.spec.effect_name, first.action.business_key);
        assert.equal(action?.action_id, first.action.action_id, `seed=${seed} step=${step} identity drift`);
      }
    });
  }
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
