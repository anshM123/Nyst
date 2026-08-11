import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderOffboardingRunHtml } from "../src/offboarding/offboardingDemo.js";
import { Ed25519Signer, type Signer, type SignatureEnvelope } from "../src/core/signing.js";
import { OffboardingCollisionError } from "../src/offboarding/offboardingRun.js";
import { verifyResolution } from "../src/engine/resolver.js";
import { StaleDecisionError } from "../src/runtime/nystRuntime.js";
import { makeOffboardingHarness, offboardingIntent } from "./offboardingHelpers.js";
import { createMemoryStore } from "../src/store/memoryStore.js";

describe("Gate 6 integrated offboarding coordinator", () => {
  it("completes clean Okta suspension then GitHub removal from current signed truth", async () => {
    const h = makeOffboardingHarness();
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.status, "SUSPENDED");
    assert.equal(h.githubTransport.role, "none");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
    assert.equal(view.okta.resolution?.effect.state, "satisfied_unattributed");
    assert.equal(view.github.resolution?.effect.state, "satisfied_unattributed");
    assert.equal(verifyResolution(h.signer, view.okta.resolution!), true);
    assert.equal(verifyResolution(h.signer, view.github.resolution!), true);
  });

  it("recovers Okta response loss without redispatch and safely continues", async () => {
    const h = makeOffboardingHarness();
    h.oktaTransport.responseLossAfterEffect = true;
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
    assert.equal(view.okta.resolution?.control.retry, "forbidden");
  });

  it("recovers GitHub response loss without redispatch or false completion", async () => {
    const h = makeOffboardingHarness();
    h.githubTransport.responseLossAfterEffect = true;
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.githubTransport.mutationCount, 1);
    assert.equal(view.github.resolution?.control.retry, "forbidden");
  });

  it("blocks GitHub when Okta observation is unavailable", async () => {
    const h = makeOffboardingHarness();
    h.oktaTransport.forceReadStatus = 503;
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "blocked_okta");
    assert.equal(h.oktaTransport.mutationCount, 0);
    assert.equal(h.githubTransport.mutationCount, 0);
  });

  it("never completes when inherited GitHub access remains", async () => {
    const h = makeOffboardingHarness();
    h.githubTransport.inheritedRoleAfterRemoval = "read";
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "blocked_github");
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("blocks when Okta returns ACTIVE after a successful suspend response", async () => {
    const h = makeOffboardingHarness();
    h.oktaTransport.successfulResponseWithoutEffect = true;
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "blocked_okta");
    assert.equal(h.githubTransport.mutationCount, 0);
  });

  it("blocks GitHub provider unavailability after a proven Okta step", async () => {
    const h = makeOffboardingHarness();
    h.githubTransport.forceStatus = 503;
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "blocked_github");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 0);
  });

  it("fails closed on either provider rate limit", async () => {
    const okta = makeOffboardingHarness();
    okta.oktaTransport.forceReadStatus = 429;
    assert.equal((await okta.coordinator.execute(offboardingIntent())).status, "blocked_okta");
    assert.equal(okta.githubTransport.mutationCount, 0);

    const github = makeOffboardingHarness();
    github.githubTransport.forceStatus = 429;
    assert.equal((await github.coordinator.execute(offboardingIntent({ business_key: "gate6-rate-github", subject: { subject_key: "rate-github", display_name: "Rate Fixture" } }))).status, "blocked_github");
    assert.equal(github.githubTransport.mutationCount, 0);
  });

  it("handles one or both goals preexisting without unnecessary writes", async () => {
    const one = makeOffboardingHarness();
    one.oktaTransport.status = "SUSPENDED";
    assert.equal((await one.coordinator.execute(offboardingIntent())).status, "complete");
    assert.equal(one.oktaTransport.mutationCount, 0);
    assert.equal(one.githubTransport.mutationCount, 1);

    const both = makeOffboardingHarness();
    both.oktaTransport.status = "SUSPENDED";
    both.githubTransport.role = "none";
    both.githubTransport.direct = false;
    assert.equal((await both.coordinator.execute(offboardingIntent({ business_key: "gate6-both-preexisting", subject: { subject_key: "both-preexisting", display_name: "Preexisting Fixture" } }))).status, "complete");
    assert.equal(both.oktaTransport.mutationCount, 0);
    assert.equal(both.githubTransport.mutationCount, 0);
  });

  it("recovers a crash after the GitHub consequence without a duplicate write", async () => {
    let crash = true;
    const h = makeOffboardingHarness(undefined, { fault_injector: (point, action) => {
      if (crash && point === "after_provider_mutation" && action.effect_name.includes("github")) {
        crash = false;
        throw new Error("simulated response loss at process boundary");
      }
    }});
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("restarts between providers from persisted action references", async () => {
    let crash = true;
    const h = makeOffboardingHarness(undefined, { fault_injector: (point, action) => {
      if (crash && point === "after_resolution_persistence" && action.effect_name.includes("okta")) {
        crash = false;
        const error = new Error("restart between providers"); error.name = "ProcessCrashError"; throw error;
      }
    }});
    await assert.rejects(() => h.coordinator.execute(offboardingIntent()));
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("restarts after both effects before final demo state derivation", async () => {
    let crash = true;
    const h = makeOffboardingHarness(undefined, { fault_injector: (point, action) => {
      if (crash && point === "after_resolution_persistence" && action.effect_name.includes("github")) {
        crash = false;
        const error = new Error("restart after both effects"); error.name = "ProcessCrashError"; throw error;
      }
    }});
    await assert.rejects(() => h.coordinator.execute(offboardingIntent()));
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("recovers a signer failure after the Okta effect without redispatch", async () => {
    const delegate = Ed25519Signer.ephemeral("gate6-fail-once-key");
    let fail = true;
    const signer: Signer = {
      keyId: delegate.keyId,
      publicKeyB64: () => delegate.publicKeyB64(),
      sign: (content: unknown): SignatureEnvelope => {
        if (fail) { fail = false; throw new Error("injected signer failure"); }
        return delegate.sign(content);
      },
      verify: (content, signature) => delegate.verify(content, signature),
    };
    const h = makeOffboardingHarness(undefined, {}, signer);
    assert.equal((await h.coordinator.execute(offboardingIntent())).status, "blocked_okta");
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("recovers a database evidence failure after consequence without duplicate effect", async () => {
    const store = createMemoryStore();
    const original = store.evidence;
    let consequence = false;
    let fail = true;
    store.evidence = {
      append: async (evidence) => {
        if (consequence && fail) { fail = false; throw new Error("injected database write failure"); }
        return original.append(evidence);
      },
      listForAction: (actionId) => original.listForAction(actionId),
    };
    const h = makeOffboardingHarness(store);
    h.oktaTransport.beforeMutation = () => { consequence = true; };
    const view = await h.coordinator.execute(offboardingIntent());
    assert.equal(view.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("deduplicates concurrent identical runs and provider writes", async () => {
    const h = makeOffboardingHarness();
    const views = await Promise.all(Array.from({ length: 10 }, () => h.coordinator.execute(offboardingIntent())));
    assert.equal(new Set(views.map((view) => view.run.run_id)).size, 1);
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
    const final = await h.coordinator.view(views[0]!.run.run_id);
    assert.equal(final.status, "complete");
  });

  it("rejects conflicting reuse of a business key", async () => {
    const h = makeOffboardingHarness();
    await h.coordinator.execute(offboardingIntent());
    await assert.rejects(
      () => h.coordinator.execute(offboardingIntent({ subject: { subject_key: "employee-fixture-2", display_name: "Different" } })),
      OffboardingCollisionError
    );
  });

  it("rejects a conflicting second run for the same subject", async () => {
    const h = makeOffboardingHarness();
    await h.coordinator.execute(offboardingIntent());
    await assert.rejects(
      () => h.coordinator.execute(offboardingIntent({ business_key: "gate6-run-2" })),
      OffboardingCollisionError
    );
  });

  it("recovers a crash after the Okta consequence from the persisted action", async () => {
    let crash = true;
    const h = makeOffboardingHarness(undefined, { fault_injector: (point, action) => {
      if (crash && point === "after_provider_mutation" && action.effect_name.includes("okta")) {
        crash = false;
        throw new Error("simulated process crash");
      }
    }});
    const first = await h.coordinator.execute(offboardingIntent());
    assert.equal(first.status, "complete");
    assert.equal(h.oktaTransport.mutationCount, 1);
    assert.equal(h.githubTransport.mutationCount, 1);
  });

  it("atomically rejects stale continuation at downstream dispatch ownership", async () => {
    const h = makeOffboardingHarness();
    let injected = false;
    h.githubTransport.beforeMutation = async () => { injected = true; };
    const first = await h.coordinator.execute(offboardingIntent());
    assert.equal(first.status, "complete");
    assert.equal(injected, true);
    const old = first.okta.resolution!;
    await h.runtime.reconcile(old.action_id);
    await assert.rejects(
      async () => h.runtime.commit(
        "github.repository_permission_change",
        "gate6-stale-direct-test",
        (await h.store.actions.getAction(first.github.action_id!))!.input,
        (await h.store.actions.getAction(first.github.action_id!))!.context,
        { continuation_guard: { action_id: old.action_id, resolution_id: old.resolution_id } }
      ),
      StaleDecisionError
    );
  });

  it("renders escaped runtime data and the seven-stage product explanation", async () => {
    const h = makeOffboardingHarness();
    const view = await h.coordinator.execute(offboardingIntent({ subject: { subject_key: "employee-xss", display_name: "<script>alert(1)</script>" } }));
    const html = renderOffboardingRunHtml(view);
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.match(html, /&lt;script&gt;/);
    for (const label of ["Intent","Execution","Observation","Reconciliation","EffectState","ControlDecision","Signed receipt"]) assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /TEST_OKTA_ACCESS_TOKEN|github_pat_/);
  });
});
