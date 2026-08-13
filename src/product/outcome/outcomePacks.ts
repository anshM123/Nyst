/**
 * OUTCOME PACKS, EFFECT INTELLIGENCE, and the EFFECT DEPENDENCY GRAPH.
 *
 * An OutcomeSpec answers one question: what class of real-world condition can
 * Nyst establish? An Outcome Pack is that spec plus everything needed to
 * actually run it — invariants, the EffectSpecs it depends on, what evidence
 * and capabilities it needs, a policy template, a recommended AutonomyLine,
 * remediation semantics, and the Failure Lab scenarios that prove it works.
 *
 * The flagship pack is Employee Offboarding, and it exists because of one
 * specific, extremely common, extremely expensive failure:
 *
 *     The offboarding agent removed Alice's direct repository access.
 *     The action was VERIFIED. Every log says success.
 *     Alice is in a team that grants WRITE to the same repository.
 *     Alice still has production access.
 *
 * Everything in the effect layer is correct. The outcome is false. That gap is
 * the entire reason this layer exists.
 */
import { GITHUB_EFFECT_NAME } from "../../providers/github/types.js";
import { OKTA_EFFECT_NAME } from "../../providers/okta/types.js";
import type { Invariant } from "./invariantEngine.js";

/* ==================================================== EFFECT INTELLIGENCE */

/**
 * Typed, versioned semantic knowledge about one supported effect.
 *
 * This is Nyst's internal technical intelligence: what the provider actually
 * means, where it lies, and how to tell. The public UI summarises it in plain
 * language — a customer should never have to read `consistency_behaviour` to
 * understand what Nyst is protecting them from.
 */
export interface EffectIntelligence {
  effect_name: string;
  version: string;
  /** What "success" from this provider actually establishes. Usually less than it looks. */
  success_meaning: string;
  /** How the affected resource is identified, stably, across calls. */
  resource_identity: string;
  /** The read that authoritatively establishes the post-state. */
  authoritative_observation: string;
  /** Ways the goal can be satisfied WITHOUT this effect — the source of most false success. */
  indirect_paths: readonly string[];
  consistency_behaviour: string;
  known_ambiguity_states: readonly string[];
  retry_semantics: string;
  safe_redispatch_criteria: string;
  compensation: string;
  reversible: boolean;
  evidence_freshness_seconds: number;
  known_failure_cases: readonly string[];
  native_evidence_sources: readonly string[];
  capability_requirements: readonly string[];
  /** One sentence for a customer. No jargon. */
  plain_summary: string;
}

export const EFFECT_INTELLIGENCE: Readonly<Record<string, EffectIntelligence>> = Object.freeze({
  [GITHUB_EFFECT_NAME]: Object.freeze({
    effect_name: GITHUB_EFFECT_NAME,
    version: "github-intelligence/1.0.0",
    success_meaning:
      "A 204 establishes that GitHub accepted a change to the principal's DIRECT collaborator grant on this repository. It says nothing at all about the principal's EFFECTIVE access.",
    resource_identity: "owner/repository + principal login, resolved to stable numeric ids before the write.",
    authoritative_observation:
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission returns the effective permission, which is the union of direct, team and organization-base grants.",
    indirect_paths: Object.freeze([
      "Team membership granting repository access",
      "Organization base permission",
      "Repository visibility (a public repository grants read to everyone)",
      "Outside-collaborator invitations that have not yet been accepted",
      "Enterprise-level or organization-owner role inheritance",
    ]),
    consistency_behaviour:
      "Permission reads are eventually consistent for a short window after a write. Nyst re-reads with bounded delay rather than trusting the mutation response.",
    known_ambiguity_states: Object.freeze([
      "Response lost after the effect was applied",
      "201 invitation shape racing an effective-access read",
      "200 with a null role_name immediately after removal",
    ]),
    retry_semantics:
      "Never blind. A permission change is not idempotent in its observable consequences: a retry can re-grant access a human removed in between.",
    safe_redispatch_criteria:
      "Only when the durable dispatch boundary says definitely_not_sent AND an authoritative read shows the goal is not applied.",
    compensation: "Restoring the prior direct role is supported where the prior role was observed before the change.",
    reversible: true,
    evidence_freshness_seconds: 900,
    known_failure_cases: Object.freeze([
      "Custom repository roles, whose semantics Nyst has not verified",
      "Inherited access that survives direct removal",
      "Rate limiting during the read-back window",
    ]),
    native_evidence_sources: Object.freeze(["provider_api_read", "audit_log", "provider_webhook"]),
    capability_requirements: Object.freeze(["github:repository:read", "github:organization:read", "github:collaborator:write"]),
    plain_summary:
      "Removing someone's direct access to a repository does not necessarily remove their access. Nyst checks what they can actually do afterwards.",
  }),
  [OKTA_EFFECT_NAME]: Object.freeze({
    effect_name: OKTA_EFFECT_NAME,
    version: "okta-intelligence/1.0.0",
    success_meaning:
      "A 200 establishes that Okta accepted a lifecycle transition request. The account's actual status must be read back separately.",
    resource_identity: "Okta user id, which is stable across profile and login changes.",
    authoritative_observation: "GET /api/v1/users/{id} returns the current lifecycle status.",
    indirect_paths: Object.freeze([
      "Active application sessions that outlive the account suspension",
      "API tokens issued to the user before suspension",
      "Federated identity from an upstream provider",
    ]),
    consistency_behaviour: "Lifecycle transitions are usually immediate, but a read immediately after a write can still show the prior status.",
    known_ambiguity_states: Object.freeze([
      "Response lost after the transition applied",
      "Status observed ACTIVE after a successful suspend response",
    ]),
    retry_semantics: "A lifecycle transition may be re-requested only when the current status is authoritatively observed and is not already the goal.",
    safe_redispatch_criteria: "definitely_not_sent, plus an authoritative read showing the account is not yet in the goal status.",
    compensation: "Unsuspending is supported, and is a consequential action in its own right.",
    reversible: true,
    evidence_freshness_seconds: 900,
    known_failure_cases: Object.freeze([
      "Users sourced from an upstream directory, where Okta is not authoritative",
      "Accounts holding admin roles, which Nyst refuses to transition automatically",
    ]),
    native_evidence_sources: Object.freeze(["provider_api_read", "audit_log", "provider_webhook"]),
    capability_requirements: Object.freeze(["okta:user:read", "okta:user:lifecycle"]),
    plain_summary:
      "Suspending an account is not the same as the account being suspended. Nyst reads the account back and says which one it observed.",
  }),
});

/* ================================================= EFFECT DEPENDENCY GRAPH */

/**
 * A BOUNDED safety dependency graph. Not a workflow engine.
 *
 * The only question it answers is: which facts must be established before this
 * consequential action may be permitted to continue? Nyst does not decide the
 * customer's business process, the order of their steps, or what their agent
 * should do next. It decides whether the current state of the world permits
 * consequential continuation.
 */
export interface DependencyNode {
  key: string;
  kind: "observation" | "invariant" | "effect";
  title: string;
  /** Keys this node requires to have been established first. */
  requires: readonly string[];
  /** For effect nodes, the EffectSpec it dispatches. */
  effect_name?: string;
  /** For invariant nodes, the invariant it establishes. */
  invariant_id?: string;
  /** The sentence shown when this node is what is blocking. */
  blocking_explanation: string;
}

export interface DependencyGraph {
  outcome_spec: string;
  nodes: readonly DependencyNode[];
}

/** Topological order, or an error naming the cycle. Bounded, and checked. */
export function dependencyOrder(graph: DependencyGraph): readonly string[] {
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (key: string, path: readonly string[]): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`The dependency graph for ${graph.outcome_spec} contains a cycle: ${[...path, key].join(" -> ")}`);
    }
    const node = byKey.get(key);
    if (!node) throw new Error(`The dependency graph for ${graph.outcome_spec} references an unknown node: ${key}`);
    visiting.add(key);
    for (const requirement of node.requires) visit(requirement, [...path, key]);
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };

  for (const node of graph.nodes) visit(node.key, []);
  return order;
}

/* ==================================================== THE FLAGSHIP PACK */

export interface OutcomePack {
  outcome_spec: string;
  outcome_spec_version: string;
  title: string;
  /** The sentence the customer's receipt will assert. */
  desired_outcome_statement: string;
  /** What this pack does NOT cover. Stated up front, not buried. */
  explicit_non_coverage: readonly string[];
  subject_schema: Readonly<Record<string, string>>;
  required_invariants: readonly Invariant[];
  /** Modules a customer may switch on. Selecting one makes its invariant REQUIRED. */
  optional_modules: readonly OutcomeModule[];
  supported_effect_specs: readonly string[];
  evidence_requirements: Readonly<Record<string, readonly string[]>>;
  capability_requirements: readonly string[];
  freshness_seconds: number;
  timeout_seconds: number;
  policy_template_id: string;
  recommended_autonomy_line: string;
  remediation: readonly RemediationOption[];
  failure_lab_scenarios: readonly string[];
  dependency_graph: DependencyGraph;
}

export interface OutcomeModule {
  module_id: string;
  title: string;
  /** Plain English: what selecting this actually buys, and what it costs. */
  description: string;
  invariants: readonly Invariant[];
  capability_requirements: readonly string[];
  /** What Nyst may NOT claim while this module is unselected. */
  uncovered_claim: string;
}

export interface RemediationOption {
  remediation_id: string;
  title: string;
  /** Which invariant this can move from false toward true. */
  addresses_invariant: string;
  effect_name: string;
  /** Plain English: what will actually be done to the world. */
  what_it_does: string;
  /** Whether this is reversible, and how. */
  reversibility: string;
  requires_human_authorization: boolean;
}

/** Subject placeholders the contract resolves against an OutcomeInstance subject. */
export const SUBJECT_GITHUB = "{github_subject}";
export const SUBJECT_OKTA = "{okta_subject}";
export const SUBJECT_AWS = "{aws_subject}";

export const EMPLOYEE_OFFBOARDING_PACK: OutcomePack = Object.freeze({
  outcome_spec: "employee_offboarding",
  outcome_spec_version: "employee_offboarding/1.0.0",
  title: "Employee Offboarding",
  desired_outcome_statement:
    "Employee no longer has effective production access through the configured GitHub and Okta controls.",
  // Said out loud, in the pack itself, because a customer who believes this
  // covers their VPN is worse off than one who knows it does not.
  explicit_non_coverage: Object.freeze([
    "VPN and network access",
    "SaaS applications not connected to Nyst",
    "Local credentials and cached tokens on the employee's own devices",
    "Shared accounts whose credentials the employee knows",
    "AWS, unless the AWS evidence module is explicitly selected",
  ]),
  subject_schema: Object.freeze({
    person_email: "string",
    github_login: "string",
    github_repository: "string",
    okta_user_id: "string",
  }),
  required_invariants: Object.freeze([
    Object.freeze({
      invariant_id: "github_effective_access_none",
      statement: "GitHub effective production access is NONE.",
      operator: "equals" as const,
      subject_ref: SUBJECT_GITHUB,
      property: "effective_permission",
      // "none" specifically, not "not admin". The union of direct, team and
      // base grants must come back as no access at all.
      expected: Object.freeze({ type: "string" as const, value: "none" }),
      accepts_corroborative: false,
    }),
    Object.freeze({
      invariant_id: "okta_account_disabled",
      statement: "The Okta account status is DISABLED.",
      operator: "equals" as const,
      subject_ref: SUBJECT_OKTA,
      property: "account_status",
      expected: Object.freeze({ type: "string" as const, value: "SUSPENDED" }),
      accepts_corroborative: false,
    }),
  ]),
  optional_modules: Object.freeze([
    Object.freeze({
      module_id: "aws_production_credentials",
      title: "AWS production credential evidence",
      description:
        "Nyst additionally establishes that the employee holds no active AWS access keys in the configured production account. Requires read-only IAM access.",
      invariants: Object.freeze([
        Object.freeze({
          invariant_id: "aws_active_access_keys_zero",
          statement: "The employee holds no active AWS access keys in the production account.",
          operator: "equals" as const,
          subject_ref: SUBJECT_AWS,
          property: "active_access_key_count",
          expected: Object.freeze({ type: "integer" as const, value: 0 }),
          accepts_corroborative: false,
        }),
      ]),
      capability_requirements: Object.freeze(["aws:iam:read"]),
      uncovered_claim:
        "Without this module Nyst makes NO claim about AWS access. An offboarding may be SATISFIED while the employee still holds AWS credentials.",
    }),
  ]),
  supported_effect_specs: Object.freeze([OKTA_EFFECT_NAME, GITHUB_EFFECT_NAME]),
  evidence_requirements: Object.freeze({
    [SUBJECT_GITHUB]: Object.freeze(["provider_api_read"]),
    [SUBJECT_OKTA]: Object.freeze(["provider_api_read"]),
  }),
  capability_requirements: Object.freeze([
    "github:repository:read", "github:organization:read", "github:collaborator:write",
    "okta:user:read", "okta:user:lifecycle",
  ]),
  freshness_seconds: 900,
  timeout_seconds: 86_400,
  policy_template_id: "conservative_offboarding",
  recommended_autonomy_line: "observe_and_act_within_scope",
  remediation: Object.freeze([
    Object.freeze({
      remediation_id: "remove_inherited_team_access",
      title: "Remove the team membership granting inherited access",
      addresses_invariant: "github_effective_access_none",
      effect_name: GITHUB_EFFECT_NAME,
      what_it_does:
        "Removes the employee from the specific team whose membership grants access to this repository. It does not delete the team or affect anyone else in it.",
      reversibility: "Reversible: the membership can be restored, though the original join date is not preserved.",
      requires_human_authorization: true,
    }),
  ]),
  failure_lab_scenarios: Object.freeze([
    "inherited_access_survives_direct_removal",
    "response_lost_after_effect",
    "okta_reports_active_after_successful_suspend",
    "github_read_unavailable_during_verification",
  ]),
  dependency_graph: Object.freeze({
    outcome_spec: "employee_offboarding",
    nodes: Object.freeze([
      Object.freeze({
        key: "observe_okta_status", kind: "observation" as const,
        title: "Read the Okta account's current lifecycle status",
        requires: Object.freeze([]),
        blocking_explanation: "Nyst has not read the account's status, so it cannot say whether suspension is needed or already done.",
      }),
      Object.freeze({
        key: "suspend_okta", kind: "effect" as const, effect_name: OKTA_EFFECT_NAME,
        title: "Suspend the Okta identity",
        requires: Object.freeze(["observe_okta_status"]),
        blocking_explanation: "The identity is the root of access; while it can authenticate, revoking downstream access contains nothing.",
      }),
      Object.freeze({
        key: "okta_disabled", kind: "invariant" as const, invariant_id: "okta_account_disabled",
        title: "The Okta account is observed SUSPENDED",
        requires: Object.freeze(["suspend_okta"]),
        blocking_explanation: "Nyst has not observed the account in the required status.",
      }),
      Object.freeze({
        key: "observe_github_direct", kind: "observation" as const,
        title: "Read the direct collaborator grant",
        requires: Object.freeze(["okta_disabled"]),
        blocking_explanation: "Nyst has not read the direct grant, so it cannot tell a removal from a no-op.",
      }),
      Object.freeze({
        key: "remove_github_direct", kind: "effect" as const, effect_name: GITHUB_EFFECT_NAME,
        title: "Remove the direct repository access",
        requires: Object.freeze(["observe_github_direct"]),
        blocking_explanation: "The direct grant has not been removed.",
      }),
      Object.freeze({
        key: "observe_github_effective", kind: "observation" as const,
        title: "Read the EFFECTIVE permission, including team and base grants",
        requires: Object.freeze(["remove_github_direct"]),
        blocking_explanation:
          "Nyst has not read the effective permission. Removing a direct grant does not establish that access is gone: team membership and organization base permissions survive it.",
      }),
      Object.freeze({
        key: "github_effective_none", kind: "invariant" as const, invariant_id: "github_effective_access_none",
        title: "GitHub effective access is NONE",
        requires: Object.freeze(["observe_github_effective"]),
        blocking_explanation: "The employee still has effective access to this repository through some path.",
      }),
    ]),
  }),
});

export const OUTCOME_PACKS: readonly OutcomePack[] = Object.freeze([EMPLOYEE_OFFBOARDING_PACK]);

export function outcomePack(spec: string): OutcomePack | null {
  return OUTCOME_PACKS.find((pack) => pack.outcome_spec === spec) ?? null;
}

/**
 * Resolve a pack's subject placeholders against one concrete subject.
 *
 * Invariants are declared with placeholders so the pack is a reusable
 * definition rather than a template someone string-substitutes at runtime.
 */
export function resolveInvariants(
  invariants: readonly Invariant[],
  subjectRefs: Readonly<Record<string, string>>,
): readonly Invariant[] {
  return invariants.map((invariant) => {
    const resolved = subjectRefs[invariant.subject_ref];
    if (!resolved) {
      throw new Error(`The subject ${invariant.subject_ref} required by invariant ${invariant.invariant_id} was not supplied`);
    }
    return { ...invariant, subject_ref: resolved };
  });
}
