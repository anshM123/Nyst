import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyResolution } from "../src/engine/resolver.js";
import { EMPTY_CONTEXT } from "../src/model/metadata.js";
import { GitHubRepositoryPermissionService } from "../src/providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../src/providers/github/githubSpec.js";
import { NystRuntime, StaleDecisionError } from "../src/runtime/nystRuntime.js";
import { InputCollisionError } from "../src/model/action.js";
import { ProcessCrashError, type RuntimeFaultPoint } from "../src/runtime/provider.js";
import { EffectRegistry } from "../src/runtime/registry.js";
import type { Signer, SignatureEnvelope } from "../src/core/signing.js";
import { githubInput, makeGitHubHarness } from "./githubHelpers.js";

describe("Gate 4 GitHub transport and observation faults", () => {
  for (const mode of ["dns", "connection_refused", "timeout_before_send"]) {
    it(`${mode}: proven before-send failure is retryable only through the guarded path`, async () => {
      const h = makeGitHubHarness({ role: "read" });
      h.transport.failDefinitelyBeforeSend = true;
      const result = await h.service.commit(`g4-before:${mode}`, githubInput("write"), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "not_applied");
      assert.equal(result.resolution.control.retry, "allowed");
      assert.equal(result.resolution.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 0);
    });
  }

  for (const mode of ["connection_reset", "ambiguous_send", "response_timeout"]) {
    it(`${mode}: may-have-been-sent never authorizes blind retry`, async () => {
      const h = makeGitHubHarness({ role: "read" });
      h.transport.failMayHaveBeenSentBeforeEffect = true;
      const result = await h.service.commit(`g4-ambiguous:${mode}`, githubInput("write"), EMPTY_CONTEXT);
      assert.equal(result.resolution.effect.state, "pending");
      assert.equal(result.resolution.control.retry, "forbidden");
      assert.equal(result.resolution.control.continuation, "blocked");
      assert.equal(h.transport.mutationCount, 0);
    });
  }

  it("discards a response only after the provider effect and reconciles with one write", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.responseLossAfterEffect = true;
    const result = await h.service.commit("g4-response-loss", githubInput("admin"), EMPTY_CONTEXT);
    assert.equal(h.transport.mutationCount, 1);
    assert.equal(result.resolution.effect.state, "satisfied_unattributed");
    assert.equal(result.resolution.control.retry, "forbidden");
    const recovered = await h.runtime.recover(result.action.action_id);
    assert.equal(recovered.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("malformed provider read fails closed and invalidates prior continuation", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const first = await h.service.commit("g4-malformed", githubInput("write"), EMPTY_CONTEXT);
    h.transport.malformedPermissionResponse = true;
    const result = await h.runtime.reconcile(first.action.action_id);
    assert.equal(result.effect.state, "unprovable");
    assert.equal(result.control.retry, "forbidden");
    assert.equal(result.control.continuation, "blocked");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("bounded delayed reads do not create a polling loop or a write", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const first = await h.service.commit("g4-delayed", githubInput("write"), EMPTY_CONTEXT);
    h.transport.responseDelayMs = 3;
    const beforeRequests = h.transport.requests.length;
    await h.runtime.reconcile(first.action.action_id);
    const newRequests = h.transport.requests.length - beforeRequests;
    assert.ok(newRequests > 0 && newRequests <= 15);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("inherited higher access defeats a direct downgrade goal and blocks continuation", async () => {
    const h = makeGitHubHarness({ role: "admin" });
    h.transport.inheritedRoleAfterSet = "write";
    const first = await h.service.commit("g4-inherited-downgrade", githubInput("read"), EMPTY_CONTEXT);
    assert.equal(first.resolution.effect.state, "pending");
    assert.equal(first.resolution.control.continuation, "blocked");
    h.clock.advance(6 * 60_000);
    const terminal = await h.runtime.reconcile(first.action.action_id);
    assert.equal(terminal.effect.state, "not_applied");
    assert.equal(terminal.control.retry, "forbidden");
    assert.equal(terminal.control.continuation, "blocked");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("a concurrent semantic collision chooses one intent and never performs two writes", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        h.service.commit(
          "g4-concurrent-collision",
          githubInput(index % 2 === 0 ? "write" : "admin"),
          EMPTY_CONTEXT
        )
      )
    );
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    assert.ok(fulfilled.length >= 1 && rejected.length >= 1);
    assert.ok(rejected.every((item) => item.reason instanceof InputCollisionError));
    assert.equal(new Set(fulfilled.map((item) => item.value.action.action_id)).size, 1);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("repeats response-loss and recovery ten times with exactly one write each", async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const h = makeGitHubHarness({ role: "read" });
      h.transport.responseLossAfterEffect = true;
      const result = await h.service.commit(`g4-loss-stress:${iteration}`, githubInput("write"), EMPTY_CONTEXT);
      await Promise.all(Array.from({ length: 10 }, () => h.runtime.reconcile(result.action.action_id)));
      assert.equal(h.transport.mutationCount, 1, `iteration=${iteration}`);
      assert.equal((await h.store.resolutions.latestForAction(result.action.action_id))?.effect.state,
        "satisfied_unattributed", `iteration=${iteration}`);
    }
  });

  it("demonstrates naive timeout retry duplicates attempts while Nyst remains at one", async () => {
    let naiveAttempts = 0;
    const naiveMutation = () => {
      naiveAttempts++;
      if (naiveAttempts === 1) throw new Error("response lost after effect");
    };
    try { naiveMutation(); } catch { naiveMutation(); }
    assert.equal(naiveAttempts, 2);

    const h = makeGitHubHarness({ role: "read" });
    h.transport.responseLossAfterEffect = true;
    const result = await h.service.commit("g4-naive-comparison", githubInput("write"), EMPTY_CONTEXT);
    await h.runtime.recover(result.action.action_id);
    assert.equal(h.transport.mutationCount, 1);
  });
});

describe("Gate 4 GitHub crash/restart boundaries", () => {
  const points: RuntimeFaultPoint[] = [
    "after_intent_persistence",
    "after_dispatch_plan_persistence",
    "before_dispatch_claim",
    "after_dispatch_claim",
    "after_provider_mutation",
    "before_provider_response_delivery",
    "after_provider_response",
    "before_evidence_persistence",
    "after_evidence_persistence",
    "before_reconciliation",
    "after_state_derivation",
    "after_control_derivation",
    "before_resolution_signing",
    "after_resolution_signing",
    "before_resolution_persistence",
    "after_resolution_persistence",
  ];

  for (const point of points) {
    it(`recovers GitHub-shaped action after ${point} without duplicate mutation`, async () => {
      let fired = false;
      const h = makeGitHubHarness({ role: "read" }, undefined, {
        fault_injector(at) {
          if (!fired && at === point) {
            fired = true;
            throw new ProcessCrashError(point);
          }
        },
      });
      const key = `g4-crash:${point}`;
      await assert.rejects(
        () => h.service.commit(key, githubInput("maintain"), EMPTY_CONTEXT),
        ProcessCrashError
      );
      const action = await h.store.actions.findByIdentity(h.spec.effect_name, key);
      assert.ok(action);
      const persistedPlan = action.dispatch_plan ? structuredClone(action.dispatch_plan) : null;
      const restarted = new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock);
      const resolution = await restarted.recover(action.action_id);
      assert.equal(verifyResolution(h.signer, resolution), true);
      const recoveredPlan = (await h.store.actions.getAction(action.action_id))?.dispatch_plan;
      assert.ok(recoveredPlan);
      if (persistedPlan) assert.deepEqual(recoveredPlan, persistedPlan);
      assert.ok(h.transport.mutationCount <= 1);
      assert.notEqual(resolution.effect.state, "verified");
      if (resolution.effect.state !== "satisfied_unattributed") {
        assert.equal(resolution.control.continuation, "blocked");
      }
    });
  }
});

describe("Gate 4 persistence, signer, and malicious-spec failures", () => {
  it("DB/evidence failure after provider consequence recovers by read-back without redispatch", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const append = h.store.evidence.append.bind(h.store.evidence);
    let failed = false;
    h.store.evidence.append = async (record) => {
      if (!failed && h.transport.mutationCount === 1) {
        failed = true;
        throw new ProcessCrashError("db_after_provider_effect");
      }
      return append(record);
    };
    await assert.rejects(
      () => h.service.commit("g4-db-after-effect", githubInput("write"), EMPTY_CONTEXT),
      ProcessCrashError
    );
    const action = await h.store.actions.findByIdentity(h.spec.effect_name, "g4-db-after-effect");
    assert.ok(action);
    const restarted = new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock);
    const recovered = await restarted.recover(action.action_id);
    assert.equal(recovered.effect.state, "satisfied_unattributed");
    assert.equal(h.transport.mutationCount, 1);
  });

  it("signer failure after effect preserves evidence and a healthy restart signs without redispatch", async () => {
    const h = makeGitHubHarness({ role: "read" });
    const badSigner: Signer = {
      keyId: "throwing",
      publicKeyB64: () => "unavailable",
      sign(): SignatureEnvelope { throw new Error("injected signer failure"); },
      verify: () => false,
    };
    const failing = new NystRuntime(h.store, h.registry, [h.provider], badSigner, h.clock);
    const service = new GitHubRepositoryPermissionService(failing, h.client, h.clock);
    await assert.rejects(
      () => service.commit("g4-signer", githubInput("write"), EMPTY_CONTEXT),
      /injected signer failure/
    );
    const action = await h.store.actions.findByIdentity(h.spec.effect_name, "g4-signer");
    assert.ok(action);
    assert.ok((await h.store.evidence.listForAction(action.action_id)).length > 0);
    const healthy = new NystRuntime(h.store, h.registry, [h.provider], h.signer, h.clock);
    const recovered = await healthy.recover(action.action_id);
    assert.equal(verifyResolution(h.signer, recovered), true);
    assert.equal(h.transport.mutationCount, 1);
  });

  it("malicious GitHub spec cannot turn a 204 response into verified or continuation", async () => {
    const h = makeGitHubHarness({ role: "read" });
    h.transport.successfulResponseWithoutEffect = true;
    const legitimate = createGitHubRepositoryPermissionSpec();
    const malicious = {
      ...legitimate,
      assess(_action: Parameters<typeof legitimate.assess>[0], evidence: Parameters<typeof legitimate.assess>[1]) {
        const response = evidence.find((item) =>
          (item.payload as { type?: string }).type === "github_mutation_response"
        );
        return {
          proposed_state: "verified" as const,
          provider_object_refs: response?.provider_object_id ? [response.provider_object_id] : [],
          evidence_refs: response ? [response.evidence_id] : [],
          verification_methods: ["response_inspection" as const],
          claimed_strength: "authoritative" as const,
          attribution_established: true,
        };
      },
      decide() {
        return {
          decision_version: 1,
          primary: "continue" as const,
          retry: "allowed" as const,
          continuation: "allowed" as const,
          recovery: "none" as const,
          reason_code: "MALICIOUS",
          explanation: "attempt core bypass",
          policy_version: "malicious/1",
          spec_version: legitimate.schema_version,
        };
      },
    };
    const registry = new EffectRegistry();
    registry.register(malicious);
    const runtime = new NystRuntime(h.store, registry, [h.provider], h.signer, h.clock);
    const service = new GitHubRepositoryPermissionService(runtime, h.client, h.clock);
    const result = await service.commit("g4-malicious", githubInput("admin"), EMPTY_CONTEXT);
    assert.notEqual(result.resolution.effect.state, "verified");
    assert.notEqual(result.resolution.control.retry, "allowed");
    assert.equal(result.resolution.control.continuation, "blocked");
  });

  it("stale retry and continuation decisions cannot cross a newer evidence sequence", async () => {
    const retryHarness = makeGitHubHarness({ role: "read" });
    retryHarness.transport.failDefinitelyBeforeSend = true;
    const retryable = await retryHarness.service.commit("g4-stale-retry", githubInput("write"), EMPTY_CONTEXT);
    retryHarness.transport.failDefinitelyBeforeSend = false;
    retryHarness.transport.role = "write";
    await retryHarness.runtime.reconcile(retryable.action.action_id);
    await assert.rejects(
      () => retryHarness.runtime.retry(retryable.action.action_id, retryable.resolution.resolution_id),
      StaleDecisionError
    );
    assert.equal(retryHarness.transport.mutationCount, 0);

    const continuationHarness = makeGitHubHarness({ role: "read" });
    const allowed = await continuationHarness.service.commit("g4-stale-continuation", githubInput("write"), EMPTY_CONTEXT);
    continuationHarness.transport.forceStatus = 403;
    await continuationHarness.runtime.reconcile(allowed.action.action_id);
    await assert.rejects(
      () => continuationHarness.runtime.authorizeContinuation(
        allowed.action.action_id,
        allowed.resolution.resolution_id
      ),
      StaleDecisionError
    );
  });
});
