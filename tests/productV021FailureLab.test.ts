import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessEffectShadow, privateAddress, signWebhook, verifyWebhook } from "../src/product/controlPlane.js";
import { runFailureLabEngine } from "../src/product/failureLabEngine.js";

describe("v0.2.1 engine-backed Failure Lab and EffectSpec-aware Shadow", () => {
  for (const scenario of ["response_lost", "timeout_before_send", "delayed_observation", "reconcile_rate_limit", "duplicate_caller", "process_crash", "offboarding_demo"] as const) {
    it(`derives ${scenario} from the real runtime without credentials`, async () => {
      const result = await runFailureLabEngine(scenario, "fake.repository_permission_change", 2026002);
      assert.equal(result.simulated, true);
      assert.equal(result.provider_credentials_used, false);
      assert.equal(result.signature_valid, true);
      assert.ok(result.timeline.some((item) => item.stage === "resolution"));
      assert.ok(result.provider_mutations <= 1);
      assert.equal(result.created_actions, 1);
    });
  }

  it("rejects a production or mismatched EffectSpec", async () => {
    await assert.rejects(() => runFailureLabEngine("response_lost", "github.repository_permission_change", 1), /only fake\.repository_permission_change/);
  });

  it("blocks continuation when GitHub access is inherited", () => {
    const assessment = assessEffectShadow("github.repository_permission_change", {
      transport: "success", authoritative_goal_observed: true, attempted_retry: false, attempted_continuation: true,
      provider_state: { effective_role: "read", desired_role: "read", direct_role: "none", inherited_access: true },
    });
    assert.equal(assessment.continuation_would_have_been_blocked, true);
    assert.match(String(assessment.semantics.inferred), /inherited access/);
  });

  it("rejects unsupported Okta lifecycle state and Stripe mismatch blocks", () => {
    assert.throws(() => assessEffectShadow("okta.user_suspension_change", {
      transport: "success", authoritative_goal_observed: false, attempted_retry: false, attempted_continuation: true,
      provider_state: { current_status: "DEPROVISIONED", desired_status: "SUSPENDED" },
    }), /Unsupported Okta/);
    const stripe = assessEffectShadow("stripe.refund", {
      transport: "success", authoritative_goal_observed: false, attempted_retry: false, attempted_continuation: true,
      provider_state: { object_matches_intent: false, attributed: true, provider_status: "succeeded" },
    });
    assert.equal(stripe.continuation_would_have_been_blocked, true);
  });

  it("rejects arbitrary effects and unknown envelope fields", () => {
    const observation = { transport: "ambiguous" as const, authoritative_goal_observed: null, attempted_retry: true, attempted_continuation: false, provider_state: {} };
    assert.throws(() => assessEffectShadow("arbitrary.effect", observation), /registered EffectSpec/);
    assert.throws(() => assessEffectShadow("fake.repository_permission_change", { ...observation, provider_state: { injected: true } }), /Unknown Shadow/);
  });

  it("rejects private, mapped, metadata, multicast, and documentation addresses",()=>{for(const address of ["127.0.0.1","10.1.2.3","169.254.169.254","172.16.0.1","192.168.1.1","100.64.0.1","224.0.0.1","::1","fc00::1","fe80::1","ff02::1","2001:db8::1","::ffff:127.0.0.1"])assert.equal(privateAddress(address),true,address);assert.equal(privateAddress("93.184.216.34"),false)});

  it("binds webhook signatures to stable event ID as well as bytes and time",()=>{const secret="synthetic-v021-webhook-secret-000000000";const timestamp=new Date().toISOString();const body=JSON.stringify({effect_state:"pending"});const signature=signWebhook(secret,timestamp,body,"event-a");assert.equal(verifyWebhook(secret,timestamp,body,signature,Date.now(),"event-a"),true);assert.equal(verifyWebhook(secret,timestamp,body,signature,Date.now(),"event-b"),false)});
});
