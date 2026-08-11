import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EFFECT_STATES,
  EffectStateSchema,
  isEffectState,
} from "../src/model/effectState.js";
import {
  CONTROL_DECISION_VERSION,
  ControlDecisionSchema,
  PRIMARY_DIRECTIVES,
  RETRY_DISPOSITIONS,
  CONTINUATION_DISPOSITIONS,
  RECOVERY_DISPOSITIONS,
  type ControlDecision,
} from "../src/model/controlDecision.js";
import { canonicalHash, canonicalJson } from "../src/core/canonical.js";
import { computeInputHash } from "../src/model/action.js";
import { OutcomeResolutionSchema } from "../src/model/resolution.js";

describe("Test 1+2: effect state is a closed six-value set", () => {
  it("exactly six external effect states validate", () => {
    assert.equal(EFFECT_STATES.length, 6);
    for (const s of EFFECT_STATES) {
      assert.equal(EffectStateSchema.parse(s), s);
    }
    assert.deepEqual(
      [...EFFECT_STATES].sort(),
      ["compensated", "not_applied", "pending", "satisfied_unattributed", "unprovable", "verified"]
    );
  });

  it("a seventh state is rejected", () => {
    for (const bogus of ["succeeded", "failed", "maybe", "applied", "resolved", "timeout", ""]) {
      assert.throws(() => EffectStateSchema.parse(bogus));
      assert.equal(isEffectState(bogus), false);
    }
  });
});

const validDecision: ControlDecision = {
  decision_version: CONTROL_DECISION_VERSION,
  primary: "do_not_retry",
  retry: "forbidden",
  continuation: "allowed",
  recovery: "none",
  reason_code: "TEST.OK",
  explanation: "test",
  policy_version: "p/1",
  spec_version: "s/1",
};

describe("Test 3: ControlDecision schema", () => {
  it("validates allowed directives/dispositions", () => {
    for (const primary of PRIMARY_DIRECTIVES)
      for (const retry of RETRY_DISPOSITIONS)
        for (const continuation of CONTINUATION_DISPOSITIONS)
          for (const recovery of RECOVERY_DISPOSITIONS) {
            ControlDecisionSchema.parse({ ...validDecision, primary, retry, continuation, recovery });
          }
  });

  it("rejects unknown directives, dispositions, and stray keys", () => {
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, primary: "yolo" }));
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, retry: "maybe" }));
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, continuation: "sometimes" }));
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, recovery: "reboot" }));
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, effect_state: "verified" }));
  });
});

describe("Test 4: effect state and control decision are separate axes", () => {
  it("ControlDecision carries no effect state; resolution nests them separately", () => {
    // ControlDecision schema rejects an embedded effect state (closed object).
    assert.throws(() => ControlDecisionSchema.parse({ ...validDecision, state: "verified" }));
    // Resolution schema requires BOTH a structured effect section and a
    // structured control section; a flattened single-axis document fails.
    assert.throws(() =>
      OutcomeResolutionSchema.parse({
        resolution_version: 1,
        resolution_id: "00000000-0000-4000-8000-000000000000",
        action_id: "00000000-0000-4000-8000-000000000001",
        effect_name: "x",
        business_key: "y",
        input_hash: "sha256:" + "0".repeat(64),
        outcome: "verified_and_continue", // collapsed axis — must not validate
      })
    );
    // No effect state string is a valid primary directive and vice versa.
    for (const s of EFFECT_STATES) {
      assert.equal((PRIMARY_DIRECTIVES as readonly string[]).includes(s), false);
    }
  });
});

describe("Test 5: canonical input hashing", () => {
  it("is stable across object-key ordering (recursively)", () => {
    const a = { b: 2, a: 1, nested: { y: [1, 2, { k: "v", j: 0 }], x: "s" } };
    const b = { nested: { x: "s", y: [1, 2, { j: 0, k: "v" }] }, a: 1, b: 2 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalHash(a), canonicalHash(b));
  });

  it("array order is significant; values are significant", () => {
    assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
    assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
  });

  it("computeInputHash projects only semantic fields", () => {
    const fields = ["repository_id", "principal_id", "desired_permission"] as const;
    const h1 = computeInputHash(fields, { repository_id: "r", principal_id: "a", desired_permission: "read", scenario: "x" });
    const h2 = computeInputHash(fields, { desired_permission: "read", principal_id: "a", repository_id: "r", scenario: "TOTALLY_DIFFERENT" });
    const h3 = computeInputHash(fields, { repository_id: "r", principal_id: "a", desired_permission: "admin" });
    assert.equal(h1, h2); // non-semantic field + key order do not matter
    assert.notEqual(h1, h3); // semantic change matters
  });
});
