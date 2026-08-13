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
  /** The Human Review this message is about. Used to deep-link to its controls. */
  incident_id: string;
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

/** The fragment that deep-links to one incident's controls inside Nyst. */
export function incidentFragment(incidentId: string): string {
  return `#review-${incidentId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * Build the Slack message for a Human Review.
 *
 * v0.3.0 Phase 1H: the second button used to link to `?intent=reobserve`, and
 * NOTHING IN NYST HONOURED THAT PARAMETER. It said "Request re-observation",
 * you clicked it, you landed on the incident page, and no re-observation had
 * been requested — the most dangerous kind of control, one that looks like it
 * did something.
 *
 * It now links to a fragment. Arriving at that fragment scrolls to the
 * incident and moves keyboard focus onto the real control, which is a CSRF-
 * protected POST behind a session. Nyst never mutates through a URL query
 * parameter: a link is something a chat client, a link previewer or a crawler
 * may fetch without a person deciding anything.
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
        // Not "Request re-observation": clicking a Slack link does not request
        // anything. It takes you to the control, which you then use.
        { type: "button", text: { type: "plain_text", text: "Go to the re-observation control" },
          url: `${context.incident_url}${incidentFragment(context.incident_id)}` },
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
