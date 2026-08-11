import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, sampleInput, uniqueKey } from "./helpers.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { InputCollisionError } from "../src/model/action.js";

describe("Test 6: same effect + business key + same semantic input -> one logical action", () => {
  it("returns the same action_id, second call created=false", async () => {
    const h = makeHarness();
    const bk = uniqueKey("identity");
    const r1 = await h.engine.beginAction(h.spec, bk, sampleInput({ scenario: "x" }), EMPTY_CONTEXT);
    const r2 = await h.engine.beginAction(h.spec, bk, sampleInput({ scenario: "y" }), EMPTY_CONTEXT);
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r1.action.action_id, r2.action.action_id);
  });
});

describe("Test 7: same effect + business key + different semantic input -> collision", () => {
  it("throws InputCollisionError instead of minting a new retry identity", async () => {
    const h = makeHarness();
    const bk = uniqueKey("collision");
    await h.engine.beginAction(h.spec, bk, sampleInput({ desired_permission: "read" }), EMPTY_CONTEXT);
    await assert.rejects(
      () => h.engine.beginAction(h.spec, bk, sampleInput({ desired_permission: "admin" }), EMPTY_CONTEXT),
      InputCollisionError
    );
  });
});

describe("Test 8 (memory mirror): uniqueness under concurrent creation", () => {
  it("N concurrent recordIntent calls yield exactly one action", async () => {
    const h = makeHarness();
    const bk = uniqueKey("concurrent");
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        h.engine.beginAction(h.spec, bk, sampleInput(), EMPTY_CONTEXT)
      )
    );
    const ids = new Set(results.map((r) => r.action.action_id));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
  });

  it("concurrent mixed inputs: one identity wins, others collide deterministically", async () => {
    const h = makeHarness();
    const bk = uniqueKey("concurrent-mixed");
    const settled = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        h.engine.beginAction(
          h.spec,
          bk,
          sampleInput({ desired_permission: i % 2 === 0 ? "read" : "admin" }),
          EMPTY_CONTEXT
        )
      )
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected");
    assert.ok(ok.length >= 1);
    assert.ok(failed.length >= 1);
    for (const f of failed) {
      assert.ok((f as PromiseRejectedResult).reason instanceof InputCollisionError);
    }
    const ids = new Set(
      ok.map((s) => (s as PromiseFulfilledResult<{ action: { action_id: string } }>).value.action.action_id)
    );
    assert.equal(ids.size, 1);
  });
});
