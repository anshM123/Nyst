/**
 * SLACK OPERATIONS INTEGRATION (Phase 16).
 *
 * Scope: Human Review notification, and nothing else.
 *
 * Deliberately NOTIFICATION-ONLY. Interactive Slack callbacks would mean
 * accepting inbound state-changing requests authenticated by a shared signing
 * secret, and the only actions worth exposing there are already available in
 * Nyst behind a real session. That trade is not worth the extra attack surface
 * for this release, so the message links back into Nyst instead.
 *
 * The one thing that must never exist here is a Force Continue affordance.
 *
 * Delivery reuses the existing outbound webhook worker: same SSRF protections,
 * same DNS pinning, same signed at-least-once delivery, same attempt history.
 * Slack cannot block launch — if the endpoint is unset, Nyst simply does not
 * notify.
 */
import type { InterventionSummary } from "./canonicalMetrics.js";

export interface SlackHumanReviewNotification {
  /** Slack Incoming Webhook URL. Stored as an opaque reference, never inline. */
  channel_reference: string;
  blocks: readonly unknown[];
  text: string;
}

export interface HumanReviewContext {
  action_id: string;
  agent_name: string | null;
  effect_name: string;
  environment: string;
  effect_state: string;
  control_primary: string;
  reason: string;
  /** Absolute link into Nyst. Built from the configured public origin. */
  incident_url: string;
  opened_at: string;
}

/**
 * Build the Slack message for a Human Review.
 *
 * Two safe affordances only: open the incident in Nyst, and request a
 * read-only re-observation. Both are links; neither changes state from Slack.
 */
export function buildHumanReviewMessage(context: HumanReviewContext, channelReference: string): SlackHumanReviewNotification {
  const summary = `Nyst needs a human: ${context.effect_name} in ${context.environment}`;
  return {
    channel_reference: channelReference,
    text: summary,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Nyst — human review required", emoji: false } },
      { type: "section", text: { type: "mrkdwn", text:
        `*${escapeSlack(context.effect_name)}*\n${escapeSlack(context.reason)}` } },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*Agent*\n${escapeSlack(context.agent_name ?? "unattributed")}` },
        { type: "mrkdwn", text: `*Environment*\n${escapeSlack(context.environment)}` },
        { type: "mrkdwn", text: `*Effect state*\n${escapeSlack(context.effect_state)}` },
        { type: "mrkdwn", text: `*Nyst decision*\n${escapeSlack(context.control_primary)}` },
      ] },
      { type: "context", elements: [{ type: "mrkdwn", text:
        "Nyst stopped here because it could not proceed safely on its own. It has not retried and has not continued downstream." }] },
      // Links only. There is no Force Continue, and no button that mutates
      // anything from Slack.
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Open in Nyst" }, url: context.incident_url, style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Request re-observation" }, url: `${context.incident_url}?intent=reobserve` },
      ] },
    ],
  };
}

/** Slack mrkdwn control characters, neutralised so a payload cannot inject formatting. */
export function escapeSlack(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character] ?? character)).slice(0, 500);
}

/** Human-readable label for an intervention, reused by Slack and the UI. */
export const INTERVENTION_LABELS: Readonly<Record<InterventionSummary["kind"], string>> = Object.freeze({
  retry_blocked: "Blocked retry",
  continuation_blocked: "Held continuation",
  auto_resolved: "Auto-resolved",
  human_review_opened: "Human review",
  shadow_retry_would_have_been_blocked: "Shadow: would have blocked retry",
  shadow_continuation_would_have_been_blocked: "Shadow: would have held continuation",
  blast_radius_hold: "Blast radius hold",
  freeze_blocked: "Frozen",
  recovery_needs_review: "Recovery needs review",
});
