import type { ClockAttestor } from "../core/clock.js";
import type { OutcomeResolution } from "../model/resolution.js";
import { EMPTY_CONTEXT, type ActionContext } from "../model/metadata.js";
import { GITHUB_EFFECT_NAME } from "../providers/github/types.js";
import type { GitHubRepositoryPermissionService } from "../providers/github/githubService.js";
import { OKTA_EFFECT_NAME } from "../providers/okta/types.js";
import type { OktaUserSuspensionService } from "../providers/okta/oktaService.js";
import type { NystRuntime } from "../runtime/nystRuntime.js";
import type { Store } from "../store/store.js";
import type { OffboardingRunIntent, OffboardingRunRecord } from "./offboardingRun.js";

export type OffboardingRunStatus =
  | "running_okta"
  | "blocked_okta"
  | "running_github"
  | "blocked_github"
  | "complete";

export interface OffboardingStepView {
  provider: "okta" | "github";
  action_id: string | null;
  resolution: OutcomeResolution | null;
  evidence_count: number;
  current: boolean;
  receipt_signed: boolean;
}

export interface OffboardingRunView {
  run: OffboardingRunRecord;
  status: OffboardingRunStatus;
  blocking_reason: string | null;
  okta: OffboardingStepView;
  github: OffboardingStepView;
}

const SATISFIED = new Set(["verified", "satisfied_unattributed"]);

export class OffboardingCoordinator {
  constructor(
    private readonly store: Store,
    private readonly runtime: NystRuntime,
    private readonly okta: OktaUserSuspensionService,
    private readonly github: GitHubRepositoryPermissionService,
    private readonly clock: ClockAttestor
  ) {}

  async execute(intent: Omit<OffboardingRunIntent, "created_at">): Promise<OffboardingRunView> {
    const recorded = await this.store.offboarding.recordIntent({
      ...intent,
      created_at: this.clock.now().timestamp,
    });
    let run = recorded.run;

    let oktaAction = run.okta_action_id
      ? await this.store.actions.getAction(run.okta_action_id)
      : await this.store.actions.findByIdentity(OKTA_EFFECT_NAME, this.oktaBusinessKey(run));
    if (oktaAction) {
      await this.assertOktaGoal(oktaAction.input);
      if (!run.okta_action_id) run = await this.store.offboarding.attachAction(run.run_id, "okta", oktaAction.action_id);
      await this.runtime.recover(oktaAction.action_id);
    } else {
      try {
        const result = await this.okta.commit(
          this.oktaBusinessKey(run),
          { org: run.okta.org, user_id: run.okta.user_id, desired_status: "suspended", credential_ref: run.okta.credential_ref },
          this.context(run.okta.credential_ref)
        );
        run = await this.store.offboarding.attachAction(run.run_id, "okta", result.action.action_id);
        oktaAction = result.action;
      } catch (error) {
        if (error instanceof Error && error.name === "ProcessCrashError") throw error;
        const blocked = await this.view(run.run_id);
        return {
          ...blocked,
          status: "blocked_okta",
          blocking_reason: `okta preflight: ${this.safeError(error)}`,
        };
      }
    }

    let view = await this.view(run.run_id);
    if (!this.stepAllowsContinuation(view.okta)) return view;
    const oktaResolution = view.okta.resolution!;

    let githubAction = run.github_action_id
      ? await this.store.actions.getAction(run.github_action_id)
      : await this.store.actions.findByIdentity(GITHUB_EFFECT_NAME, this.githubBusinessKey(run));
    if (githubAction) {
      await this.assertGitHubGoal(githubAction.input);
      if (!run.github_action_id) run = await this.store.offboarding.attachAction(run.run_id, "github", githubAction.action_id);
      await this.runtime.recover(githubAction.action_id);
    } else {
      try {
        const result = await this.github.commit(
          this.githubBusinessKey(run),
          {
            owner: run.github.owner,
            repository: run.github.repository,
            principal: run.github.principal,
            desired_permission: "none",
            credential_ref: run.github.credential_ref,
          },
          this.context(run.github.credential_ref),
          { continuation_guard: { action_id: oktaResolution.action_id, resolution_id: oktaResolution.resolution_id } }
        );
        run = await this.store.offboarding.attachAction(run.run_id, "github", result.action.action_id);
      } catch (error) {
        if (error instanceof Error && error.name === "ProcessCrashError") throw error;
        const blocked = await this.view(run.run_id);
        return {
          ...blocked,
          status: "blocked_github",
          blocking_reason: `github preflight or continuation: ${this.safeError(error)}`,
        };
      }
    }
    view = await this.view(run.run_id);
    return view;
  }

  async view(run_id: string): Promise<OffboardingRunView> {
    const run = await this.store.offboarding.get(run_id);
    if (!run) throw new Error(`Unknown offboarding run ${run_id}`);
    const okta = await this.step("okta", run.okta_action_id);
    const github = await this.step("github", run.github_action_id);
    let status: OffboardingRunStatus;
    let blocking: string | null = null;
    if (!okta.action_id) status = "running_okta";
    else if (!this.stepAllowsContinuation(okta)) {
      status = "blocked_okta";
      blocking = this.blockingReason(okta);
    } else if (!github.action_id) status = "running_github";
    else if (!this.stepAllowsContinuation(github)) {
      status = "blocked_github";
      blocking = this.blockingReason(github);
    } else status = "complete";
    return { run, status, blocking_reason: blocking, okta, github };
  }

  private async step(provider: "okta" | "github", action_id: string | null): Promise<OffboardingStepView> {
    if (!action_id) return { provider, action_id: null, resolution: null, evidence_count: 0, current: false, receipt_signed: false };
    const resolution = await this.store.resolutions.latestForAction(action_id);
    const evidence = await this.store.evidence.listForAction(action_id);
    const runtime = await this.store.runtime.get(action_id);
    const current = Boolean(
      resolution?.runtime && runtime &&
      resolution.runtime.resolution_sequence === runtime.resolution_sequence &&
      resolution.runtime.evidence_sequence === runtime.evidence_sequence
    );
    return {
      provider,
      action_id,
      resolution,
      evidence_count: evidence.length,
      current,
      receipt_signed: resolution?.trust.signature !== null,
    };
  }

  private stepAllowsContinuation(step: OffboardingStepView): boolean {
    return Boolean(
      step.current && step.receipt_signed && step.resolution &&
      SATISFIED.has(step.resolution.effect.state) &&
      step.resolution.control.continuation === "allowed"
    );
  }

  private blockingReason(step: OffboardingStepView): string {
    if (!step.resolution) return `${step.provider}: no resolution`;
    if (!step.current) return `${step.provider}: stale resolution or evidence`;
    if (!step.receipt_signed) return `${step.provider}: unsigned resolution`;
    if (!SATISFIED.has(step.resolution.effect.state)) return `${step.provider}: effect ${step.resolution.effect.state}`;
    return `${step.provider}: continuation ${step.resolution.control.continuation}`;
  }

  private context(credential_ref: string): ActionContext {
    return {
      ...EMPTY_CONTEXT,
      risk_magnitude: "critical",
      workload_id: "nyst.gate6.offboarding",
      workload_version: "1.0.0",
      credential_ref,
      approval: { ...EMPTY_CONTEXT.approval },
    };
  }

  private oktaBusinessKey(run: OffboardingRunRecord): string { return `offboarding:${run.business_key}:okta`; }
  private githubBusinessKey(run: OffboardingRunRecord): string { return `offboarding:${run.business_key}:github`; }

  private async assertOktaGoal(input: unknown): Promise<void> {
    if ((input as { desired_status?: unknown }).desired_status !== "suspended") {
      throw new Error("Persisted Okta action does not represent suspension");
    }
  }

  private async assertGitHubGoal(input: unknown): Promise<void> {
    if ((input as { desired_permission?: unknown }).desired_permission !== "none") {
      throw new Error("Persisted GitHub action does not represent access removal");
    }
  }

  private safeError(error: unknown): string {
    const name = error instanceof Error ? error.name : "Error";
    return name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "provider_error";
  }
}
