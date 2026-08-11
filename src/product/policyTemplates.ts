/**
 * POLICY TEMPLATES (Phase 12).
 *
 * Customers should not have to build a policy from nothing. These templates
 * are ordinary versioned policies created through the EXISTING policy engine —
 * there is no second engine and no policy DSL.
 *
 * A template can only ever make Nyst STRICTER. The Nyst safety floor is applied
 * by the runtime, not by the policy, so no template value can make Nyst less
 * safe than the core model. `retry_mode` is fixed at "never" for exactly that
 * reason: no template, and no customer edit, can enable an automatic retry of a
 * consequential action.
 */
import type { ConservativePolicy } from "./controlPlane.js";

export type PolicyTemplateId = "access_revocation" | "financial_action" | "high_risk_production";

export interface PolicyTemplate {
  template_id: PolicyTemplateId;
  name: string;
  summary: string;
  /** Plain-language statements of what this template guarantees. */
  guarantees: readonly string[];
  /** What it deliberately does NOT do, so the choice is honest. */
  boundaries: readonly string[];
  /** Suggested Blast Radius companion, expressed as product concepts. */
  suggested_blast_radius: { window_seconds: number; max_actions_per_window?: number; note: string } | null;
  policy: Omit<ConservativePolicy, "policy_version_id" | "retry_mode">;
}

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = Object.freeze([
  {
    template_id: "access_revocation",
    name: "Access Revocation",
    summary:
      "For offboarding and permission removal, where the danger is continuing a workflow before access is actually gone.",
    guarantees: [
      "Initial execution proceeds automatically where the runtime already allows it.",
      "A retry is never issued blindly; ambiguity holds instead of repeating the mutation.",
      "Downstream continuation waits until Nyst has evidence the effective access is removed.",
      "If the effect stays ambiguous past the deadline, Nyst escalates to a human instead of guessing.",
    ],
    boundaries: [
      "Nyst does not compensate an access change automatically; reinstating access is a human decision.",
      "Inherited organization or team access is reported as unresolved, not quietly treated as removed.",
    ],
    suggested_blast_radius: { window_seconds: 60, max_actions_per_window: 10, note: "A runaway offboarding agent should not strip an entire org in a minute." },
    policy: { execution_mode: "automatic", auto_continuation: true, auto_compensation: false, reconcile_timeout_seconds: 300 },
  },
  {
    template_id: "financial_action",
    name: "Financial Action",
    summary:
      "For refunds and captures, where a duplicate is money the customer cannot get back by retrying harder.",
    guarantees: [
      "A retry is never issued blindly under any circumstance.",
      "Continuation requires authoritative evidence of the financial effect, not a 2xx response.",
      "The ambiguity deadline is short, because an unresolved financial effect should reach a human quickly.",
      "Approval is required before dispatch, so a large or unexpected amount cannot execute unattended.",
    ],
    boundaries: [
      "Nyst does not reverse a financial effect automatically; compensation stays a human decision.",
      "Amount thresholds live in the Blast Radius budget, which reads the EffectSpec's authoritative amount rather than parsing text.",
    ],
    suggested_blast_radius: { window_seconds: 3600, max_actions_per_window: 30, note: "Pair with per-action and per-hour amount ceilings in the currency the effect is denominated in." },
    policy: { execution_mode: "approval_required", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 120 },
  },
  {
    template_id: "high_risk_production",
    name: "High-Risk Production",
    summary:
      "For production or customer-state changes where the safest default is that a human saw it first.",
    guarantees: [
      "A human must approve before any consequential dispatch.",
      "Read-only reconciliation still runs automatically, so ambiguity is investigated without human effort.",
      "No autonomous compensation: Nyst will not attempt to undo a production change on its own.",
      "Continuation is held until the external effect is established.",
    ],
    boundaries: [
      "This template trades throughput for caution and is not appropriate for high-volume automation.",
      "It does not prevent a human from approving a bad action; it ensures a human is present.",
    ],
    suggested_blast_radius: { window_seconds: 300, max_actions_per_window: 5, note: "Keep the approved volume small enough that a human can still follow it." },
    policy: { execution_mode: "approval_required", auto_continuation: false, auto_compensation: false, reconcile_timeout_seconds: 600 },
  },
]);

/**
 * The Nyst safety floor, stated as product copy.
 *
 * Rendered next to the policy editor so the fundamental rule is unmissable:
 * CUSTOMER POLICY CAN MAKE NYST STRICTER. IT CANNOT MAKE NYST LESS SAFE THAN
 * THE CORE SAFETY MODEL.
 */
export const NYST_SAFETY_FLOOR: readonly string[] = Object.freeze([
  "A consequential action is never retried automatically, whatever the policy says.",
  "Transport failure is never treated as proof the effect did not happen.",
  "An HTTP 2xx is never treated as proof the intended effect happened.",
  "Missing evidence is never treated as proof of non-application.",
  "Continuation is never authorized from execution state alone; it requires external effect state.",
  "No consequence begins before durable organization, project, environment and action ownership exists.",
  "Effective authority is the INTERSECTION of runtime authority and your policy, never the union.",
  "Human review may only choose operations that are already safe under the runtime and EffectSpec semantics.",
]);
