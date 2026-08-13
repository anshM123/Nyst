/**
 * Static assets served by the Nyst control plane.
 *
 * The CSS lives in designSystem.ts. The scripts below are deliberately small
 * and framework-free: NO authoritative safety logic is implemented in
 * JavaScript. Every button here calls the backend and re-renders from the
 * response. The browser is a view over persisted truth, never a second source
 * of it.
 */
import { NYST_CSS } from "./designSystem.js";

export const APP_CSS = NYST_CSS;

/** Retained so the existing asset route keeps working; the system is one sheet now. */
export const PRODUCT_ENHANCEMENT_CSS = "";

export const LOGIN_JS = `
document.getElementById("login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const error = document.getElementById("login-error");
  error.textContent = "";
  // Locking the button is a courtesy. The backend is idempotent-safe on its own.
  button.disabled = true; button.dataset.busy = "true";
  try {
    const body = Object.fromEntries(new FormData(form).entries());
    const response = await fetch("/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) { error.textContent = "Those credentials were not accepted."; return; }
    const result = await response.json();
    sessionStorage.setItem("nyst_csrf", result.csrf);
    location.href = "/";
  } catch { error.textContent = "Nyst could not be reached."; }
  finally { button.disabled = false; delete button.dataset.busy; }
});
`;

export const APP_JS = `
(() => {
  const csrf = () => sessionStorage.getItem("nyst_csrf") || "";

  /**
   * Every mutating call goes through here. The button is locked while the
   * request is in flight and an Idempotency-Key is attached, so a double click
   * cannot create two commands even if the lock is defeated.
   */
  async function send(button, method, url, body) {
    if (button.dataset.busy === "true") return null;
    button.dataset.busy = "true"; button.disabled = true;
    const original = button.textContent;
    button.textContent = "Working…";
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-nyst-csrf": csrf(),
          "idempotency-key": (button.dataset.idempotency ||= crypto.randomUUID()),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      // Prefer the server's stated reason. An error CODE tells an operator
      // nothing they can act on; "no webhook endpoint is configured" does.
      if (!response.ok) {
        announce(button, payload.detail || payload.error || "That operation was refused.", true);
        return null;
      }
      return payload;
    } catch { announce(button, "Nyst could not be reached.", true); return null; }
    finally { button.dataset.busy = "false"; button.disabled = false; button.textContent = original; }
  }

  function announce(anchor, message, isError) {
    let note = anchor.parentElement.querySelector("[data-note]");
    if (!note) {
      note = document.createElement("p");
      note.dataset.note = "true";
      // A class, not an inline style: style-src 'self' blocks style attributes,
      // so an inline style here would be dropped without a word.
      note.className = "note";
      anchor.parentElement.appendChild(note);
    }
    note.setAttribute("role", isError ? "alert" : "status");
    note.className = isError ? "note error" : "note";
    note.textContent = message;
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.signout) {
      // Ending the session is a server-side action: the cookie is httpOnly and
      // the browser cannot revoke the session record on its own.
      await send(button, "POST", "/v1/auth/logout", {});
      sessionStorage.removeItem("nyst_csrf");
      location.href = "/login";
      return;
    }

    if (button.dataset.review) {
      const result = await send(button, "POST", "/v1/reviews/" + button.dataset.review, { operation: button.dataset.operation });
      if (result) location.reload();
      return;
    }

    if (button.dataset.template) {
      const result = await send(button, "POST", "/v1/policy-templates/" + button.dataset.template, { effect_name: null });
      if (result) location.reload();
      return;
    }

    if (button.dataset.preflight) {
      const result = await send(button, "POST", "/v1/integrations/" + button.dataset.preflight + "/preflight", {});
      if (result) location.reload();
      return;
    }

    if (button.dataset.freeze) {
      // A freeze stops every new consequence in scope. Confirm deliberately.
      const reason = prompt("Activating an Emergency Freeze stops every NEW consequential action in this environment.\\n\\nRead-only reconciliation continues.\\n\\nReason for the freeze:");
      if (reason === null) return;
      const result = await send(button, "POST", "/v1/freezes", { reason });
      if (result) location.reload();
      return;
    }

    if (button.dataset.unfreeze) {
      const reason = prompt("Releasing the freeze allows new consequential actions again.\\n\\nReason for releasing:");
      if (reason === null) return;
      const result = await send(button, "POST", "/v1/freezes/" + button.dataset.unfreeze + "/release", { confirm: true, reason });
      if (result) location.reload();
      return;
    }
  });

  /**
   * Project / environment switch.
   *
   * The endpoint is JSON + CSRF, so a native form POST would be refused. The
   * form still carries a real method and action so the control is honest about
   * where it goes; this handler is what actually issues the request.
   */
  document.getElementById("nyst-project-context")?.addEventListener("submit", async (event) => {
    if (event.currentTarget.tagName !== "FORM") return;
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const [projectId, environmentId] = String(new FormData(form).get("context") || "").split(":");
    const result = await send(button, "POST", "/v1/context", {
      project_id: projectId, environment_id: environmentId,
    });
    if (result) location.href = "/";
  });

  /**
   * Deep link from a notification to one incident's REAL control.
   *
   * Slack used to link to a re-observation intent query parameter, which
   * nothing honoured: you
   * clicked a button labelled "Request re-observation" and nothing was
   * requested. Nyst does not mutate through URL parameters — a link is
   * something a chat client or a link previewer may fetch with nobody
   * deciding anything. So arriving here scrolls to the incident and puts
   * keyboard focus on the control, and the person presses it.
   */
  const focusIncident = () => {
    const match = /^#review-[A-Za-z0-9_-]+$/.exec(location.hash);
    if (!match) return;
    const incident = document.querySelector(location.hash);
    if (!incident) return;
    incident.scrollIntoView({ block: "center" });
    const control = incident.querySelector("button[data-operation='request_reobservation']:not([disabled])")
      || incident.querySelector("button[data-review]:not([disabled])")
      || incident;
    control.focus();
    incident.classList.add("is-deep-linked");
  };
  focusIncident();
  window.addEventListener("hashchange", focusIncident);

  document.getElementById("lab-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const data = Object.fromEntries(new FormData(form).entries());
    const result = await send(button, "POST", "/v1/failure-lab/runs", { scenario: data.scenario, seed: Number(data.seed) });
    if (result) location.reload();
  });
})();
`;
