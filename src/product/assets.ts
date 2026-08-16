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
  // A session cookie can survive a new tab while sessionStorage does not.
  // Hydrate a fresh CSRF token for that existing browser session.
  const csrfReady = sessionStorage.getItem("nyst_csrf")
    ? Promise.resolve()
    : fetch("/v1/auth/csrf", { credentials: "same-origin" })
        .then((response) => response.ok ? response.json() : null)
        .then((result) => { if (result?.csrf) sessionStorage.setItem("nyst_csrf", result.csrf); })
        .catch(() => undefined);
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
      await csrfReady;
      /**
       * ONE KEY PER ATTEMPT, NOT ONE PER BUTTON FOREVER.
       *
       * This was ||=, so a button minted a key once and reused it for the rest
       * of the page's life. The CSRF retry below needs the same key — a retry
       * must never become a second command — but a DELIBERATE second press is
       * a new request, and reusing the key made the server answer it from the
       * idempotency record of the first.
       *
       * So the key is fresh per press and stable within a press. A repeated
       * press is still safe: the business key deduplicates the logical action
       * on the server, which is the layer that should be doing it.
       */
      const key = crypto.randomUUID();
      button.dataset.idempotency = key;
      const attempt = () => fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-nyst-csrf": csrf(),
          "idempotency-key": key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      let response = await attempt();

      /**
       * A STALE CSRF TOKEN HEALS ITSELF ONCE.
       *
       * sessionStorage is per-tab and outlives a lot: a token minted in this
       * tab can be superseded, and a deployment that changes how tokens are
       * derived leaves every open tab holding a value the server no longer
       * accepts. Before this, the only cure was signing out and back in, and
       * the person was shown "CSRF rejected" with no hint that this was the
       * remedy.
       *
       * Retried EXACTLY once, and only for 403, and only after obtaining a
       * fresh token — so a genuine authorization failure still surfaces rather
       * than looping.
       */
      if (response.status === 403) {
        const refreshed = await fetch("/v1/auth/csrf", { credentials: "same-origin" })
          .then((r) => r.ok ? r.json() : null).catch(() => null);
        if (refreshed && refreshed.csrf && refreshed.csrf !== csrf()) {
          sessionStorage.setItem("nyst_csrf", refreshed.csrf);
          response = await attempt();
        }
      }

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

    /**
     * Enable or disable one EffectSpec for this environment.
     *
     * The route existed from the beginning; nothing in the interface called it,
     * so readiness could say "Enabled: NO" with no way to act on it.
     */
    if (button.dataset.effectSpec) {
      const enable = button.dataset.enabled !== "true";
      const result = await send(button, "PUT", "/v1/effect-specs/" + encodeURIComponent(button.dataset.effectSpec), { enabled: enable });
      if (result) location.reload();
      return;
    }

    /**
     * A PERSON VOUCHES FOR A CAPABILITY NOTHING COULD OBSERVE.
     *
     * The last resort, and deliberately the least comfortable control on the
     * page: it records a CLAIM, and every screen that shows the result says so.
     * A justification is required because this is the one capability state that
     * rests on somebody's word, and an audit will want to know whose and why.
     */
    if (button.dataset.attest) {
      const capability = button.dataset.capability;
      const justification = prompt(
        "ATTESTING IS NOT OBSERVING.\\n\\n" + capability + " cannot be confirmed by a read-only check — proving a "
        + "write would require performing one. Recording it here states that YOU know this credential holds it, and "
        + "Nyst will label it a claim wherever it appears.\\n\\nHow do you know?");
      if (justification === null) return;
      if (justification.trim().length < 10) {
        announce(button, "An attestation needs a justification somebody can evaluate later.", true);
        return;
      }
      const result = await send(button, "POST", "/v1/integrations/" + button.dataset.attest + "/capabilities/attest",
        { capability, justification });
      if (result) location.reload();
      return;
    }

    /**
     * CREATE AN API KEY, and show the secret exactly once.
     *
     * The one place in the product where Nyst deliberately displays a secret.
     * It is shown ONCE because only a hash is stored, so it cannot be shown
     * again — and the UI has to make that unmissable rather than let someone
     * navigate away and lose it.
     *
     * It goes into a selectable field, never into a prompt() and never into
     * the clipboard automatically: a silent clipboard write moves a credential
     * somewhere the person did not ask for it.
     */
    if (button.dataset.createKey) {
      const name = prompt("Name this key so you can tell it apart later, e.g. \\"offboarding bot\\":");
      if (name === null) return;
      if (name.trim().length < 3) { announce(button, "A key needs a name you will recognise later.", true); return; }
      const result = await send(button, "POST", "/v1/api-keys", {
        name: name.trim(), scopes: button.dataset.createKey.split(","),
      });
      if (!result || !result.key) return;
      showKeyOnce(button, result.key);
      return;
    }

    if (button.dataset.revokeKey) {
      if (!confirm("Revoke this key? Anything using it stops working immediately. This cannot be undone.")) return;
      const result = await send(button, "DELETE", "/v1/api-keys/" + button.dataset.revokeKey, {});
      if (result) location.reload();
      return;
    }

    if (button.dataset.preflight) {
      const result = await send(button, "POST", "/v1/integrations/" + button.dataset.preflight + "/preflight", {});
      if (result) location.reload();
      return;
    }

    /**
     * LEAVING SHADOW.
     *
     * Confirmed deliberately, and the reason is required rather than generated:
     * the audit row this writes is immutable and somebody will read it during
     * an incident six months from now. "Changed via UI" would be useless then.
     *
     * A refusal here is rendered in place by send(), which already prefers the
     * server's stated reason — so a 402 shows the commercial sentence and a 409
     * shows the safety one, rather than both collapsing into "failed".
     */
    if (button.dataset.setMode) {
      const mode = button.dataset.setMode;
      const warning = mode === "shadow"
        ? "Returning to Shadow. Nyst will evaluate everything and prevent nothing."
        : "Moving to " + mode.toUpperCase() + " means Nyst will begin REFUSING your software's actions, not just reporting on them.\\n\\nThis is recorded permanently and cannot be edited afterwards.";
      const reason = prompt(warning + "\\n\\nWhy are you making this change?");
      if (reason === null) return;
      if (reason.trim().length < 5 && mode !== "shadow") {
        announce(button, "Leaving Shadow requires a reason a person can read later.", true);
        return;
      }
      const result = await send(button, "PUT", "/v1/environment/mode", { mode, reason });
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

  /**
   * THE FAILURE LAB OUTCOME CONTROLS (v0.3.3).
   *
   * THE DEFECT. These forms were rendered with data-lab-outcome and NOTHING
   * LISTENED FOR THEM. So the browser performed a native form POST to a
   * JSON+CSRF API: no CSRF header, wrong content type, 403, and the browser
   * painted the raw JSON error body in its own viewer. A customer clicked a
   * button on the flagship demonstration page and landed on a black screen full
   * of pretty-printed error JSON.
   *
   * Two rules follow from that, and both are asserted by tests.
   *
   * NEVER NAVIGATE. Whatever happens — success, refusal, network failure — the
   * customer stays on this page. Navigation is the failure being replaced.
   *
   * NEVER RELOAD. A lab run is COMPUTED AND RETURNED, never stored: it is a
   * simulation, and persisting simulated verdicts next to real ones is exactly
   * the confusion the SIMULATION banner exists to prevent. So a reload would
   * silently discard the result the customer just asked for.
   */
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-lab-outcome]");
    if (!form) return;
    event.preventDefault();
    const fault = form.dataset.labOutcome;
    const button = form.querySelector("button");
    const result = await send(button, "POST", "/v1/failure-lab/outcome-runs", { fault, seed: 1 });
    if (result) renderOutcomeRun(form, result);
  });

  /**
   * Render the verdict beside the control that produced it.
   *
   * The three verdicts get three different treatments and INDETERMINATE is not
   * a lesser version of the other two — it is Nyst concluding that it looked
   * and cannot establish what is true, which is the answer this product exists
   * to be able to give.
   */
  function renderOutcomeRun(form, result) {
    const row = form.closest("tr") || form.parentElement;
    let panel = row.parentElement.querySelector("[data-lab-outcome-result]");
    if (!panel) {
      panel = document.createElement("tr");
      panel.dataset.labOutcomeResult = "true";
      const cell = document.createElement("td");
      cell.colSpan = 4;
      panel.appendChild(cell);
      row.parentElement.insertBefore(panel, row.nextSibling);
    }
    const evaluation = result.evaluation || {};
    void evaluation;
    const verdict = String(evaluation.verdict || "indeterminate");
    const badge = verdict === "satisfied" ? "resolved" : verdict === "unsatisfied" ? "blocked" : "uncertain";
    const invariants = (evaluation.required || []).map((invariant) => {
      const state = invariant.result === "true" ? "pass" : invariant.result === "false" ? "fail" : "unknown";
      const word = invariant.result === "true" ? "Holds" : invariant.result === "false" ? "FALSE" : "Unknown";
      return '<li><span class="state ' + state + '">' + word + '</span>'
        + '<span class="body"><strong>' + text(invariant.statement) + '</strong>'
        + '<span>' + text(invariant.reason) + '</span></span></li>';
    }).join("");
    const coverage = evaluation.coverage || {};
    panel.firstChild.innerHTML =
      '<div class="lab-result">'
      + '<div class="split-top"><h3>' + text((result.description || {}).title || result.label || "Result") + '</h3>'
      + '<span class="badge ' + badge + '">' + text(verdict) + '</span></div>'
      + (invariants ? '<ul class="checks gap-m">' + invariants + '</ul>' : "")
      + '<p class="small gap-m">Coverage ' + text(coverage.numerator) + "/" + text(coverage.denominator)
      + ". Seed " + text(result.seed) + ", so this run reproduces exactly. "
      + "SIMULATION: no provider was contacted and nothing was mutated.</p></div>";
    panel.scrollIntoView({ block: "nearest" });
  }

  /**
   * The one and only time this value exists outside the customer's own storage.
   *
   * Deliberately NOT auto-copied and NOT in a prompt(): a silent clipboard
   * write puts a credential somewhere nobody asked for it, and a prompt is
   * dismissed by reflex. It is a selectable field with an explicit copy button,
   * and the page does not reload until the person says they have it — a reload
   * would destroy the only copy.
   */
  function showKeyOnce(button, secret) {
    const panel = document.createElement("div");
    panel.className = "panel panel-pad gap-m key-reveal";
    const title = document.createElement("h3");
    title.textContent = "Copy this now — it is not shown again";
    const field = document.createElement("input");
    field.readOnly = true; field.className = "key-secret"; field.value = secret;
    const note = document.createElement("p");
    note.className = "small";
    note.textContent = "Nyst stores only a hash of this key. Nobody, including Nyst, can show it to you again. "
      + "If you lose it, revoke it and create another.";
    const row = document.createElement("div");
    row.className = "button-row";
    const copy = document.createElement("button");
    copy.type = "button"; copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      field.select();
      navigator.clipboard?.writeText(secret).then(() => { copy.textContent = "Copied"; }).catch(() => undefined);
    });
    const done = document.createElement("button");
    done.type = "button"; done.textContent = "I have saved it";
    done.addEventListener("click", () => location.reload());
    row.appendChild(copy); row.appendChild(done);
    panel.appendChild(title); panel.appendChild(field); panel.appendChild(note); panel.appendChild(row);
    button.parentElement.parentElement.appendChild(panel);
    field.focus(); field.select();
  }

  /** Escape before insertion. Everything here comes from a response body. */
  function text(value) {
    const node = document.createElement("span");
    node.textContent = value === undefined || value === null ? "" : String(value);
    return node.innerHTML;
  }

  /**
   * RUN A CONSEQUENTIAL ACTION FROM THE PAGE (v0.3.3).
   *
   * The business key is generated here and shown, because it is the identity
   * Nyst deduplicates on: pressing the button twice with the same key is ONE
   * logical action, which is the behaviour a person testing this should be
   * able to see rather than read about.
   */
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-dispatch]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector("button");
    for (const field of ["owner", "repository", "principal"]) {
      if (!String(data[field] || "").trim()) {
        announce(button, "Fill in " + field + " first.", true);
        return;
      }
    }
    const businessKey = "ui-" + data.owner + "/" + data.repository + "/" + data.principal
      + "/" + data.desired_permission;

    /**
     * THE HUMAN APPROVAL IS THE PERSON PRESSING THE BUTTON — SAID OUT LOUD.
     *
     * When the effective policy is approval_required, the route refuses a
     * dispatch unless a SESSION principal sends approved:true. That is the
     * design: an API key can never approve its own action, and a signed-in
     * human can. The form did not send it, so the control refused itself with
     * "Human approval required before execution" and no way to provide it.
     *
     * It is NOT attached silently. Approving is a distinct act from filling in
     * a form, so it gets its own confirmation naming exactly what is about to
     * happen — and the answer is what gets sent, rather than the request
     * carrying an approval nobody consciously gave.
     */
    const approved = confirm(
      "You are about to remove access for " + data.principal + " on " + data.owner + "/" + data.repository
      + " on GitHub, for real.\\n\\nThis environment is ENFORCED and the effective policy requires a HUMAN "
      + "APPROVAL. Pressing OK records that YOU approved it, against your signed-in identity.\\n\\nProceed?");
    if (!approved) { announce(button, "Not approved. Nothing was sent.", false); return; }

    const result = await send(button, "POST", "/v1/actions", {
      effect: form.dataset.dispatch,
      businessKey,
      // Only ever true because a person just said so, in the dialog above.
      approved: true,
      input: {
        owner: String(data.owner).trim(),
        repository: String(data.repository).trim(),
        principal: String(data.principal).trim(),
        desired_permission: data.desired_permission,
      },
    });
    if (result) renderDispatch(form, result, businessKey);
  });

  /**
   * The answer, in the product's own vocabulary.
   *
   * The pair that matters is EFFECT plus OUTCOME, and they are shown side by
   * side because the whole proposition is that they can disagree. Collapsing
   * them into one "status" is the defect this product exists to remove, so the
   * one screen a person is most likely to look at must not do it.
   */
  function renderDispatch(form, result, businessKey) {
    let panel = form.parentElement.querySelector("[data-dispatch-result]");
    if (!panel) {
      panel = document.createElement("div");
      panel.dataset.dispatchResult = "true";
      form.parentElement.appendChild(panel);
    }
    /**
     * READ THE SHAPE THE ROUTE ACTUALLY RETURNS.
     *
     * This read result.effect_state and result.control_decision, neither of
     * which exists. POST /v1/actions returns { action, created, resolution },
     * and the resolution document carries effect.state and control.primary.
     *
     * So the FIRST REAL CONSEQUENTIAL ACTION NYST EVER PERFORMED — a
     * collaborator genuinely removed from a live GitHub repository — was
     * displayed as "unknown", and the only way to discover it had worked was
     * to go and look at GitHub. A result panel that cannot read its own
     * response is worse than none: it turns a success into an apparent error.
     */
    const document = (result.resolution && result.resolution.document) || {};
    const effect = String((document.effect && document.effect.state)
      || (result.action && result.action.effect_state) || "unknown");
    const outcome = result.outcome ? String(result.outcome.verdict || "") : "";
    const decision = String((document.control && document.control.primary) || "");
    const explanation = String((document.control && document.control.explanation) || "");

    /**
     * created:false MEANS NYST DEDUPLICATED IT, NOT THAT IT FAILED.
     *
     * The business key is derived from the inputs, so re-running the same
     * removal is ONE logical action by design — that is what stops a retry
     * becoming a second consequence. Re-running after re-adding the person
     * therefore returned the original record and looked, from the outside,
     * exactly like nothing happening.
     *
     * Correct behaviour, invisible presentation. It is now stated.
     */
    const deduplicated = result.created === false;
    const badge = (value) => value === "verified" || value === "satisfied" ? "resolved"
      : value === "not_applied" || value === "unsatisfied" ? "blocked" : "uncertain";
    panel.innerHTML =
      '<div class="lab-result">'
      + '<div class="split-top"><h3>Result</h3>'
      + '<span class="badge ' + badge(effect) + '">' + text(effect) + '</span></div>'
      + '<dl class="facts gap-m">'
      + '<div><dt>Effect — what happened to the operation</dt><dd>' + text(effect) + '</dd></div>'
      + (outcome ? '<div><dt>Outcome — what became true</dt><dd>' + text(outcome) + '</dd></div>' : "")
      + (decision ? '<div><dt>Decision</dt><dd>' + text(decision) + '</dd></div>' : "")
      + (explanation ? '<div><dt>Because</dt><dd>' + text(explanation) + '</dd></div>' : "")
      + '<div><dt>Business key</dt><dd class="mono">' + text(businessKey) + '</dd></div>'
      + '</dl>'
      + (deduplicated
        ? '<p class="note gap-m"><strong>Nothing new was performed.</strong> An action already exists for this '
          + 'business key, so Nyst returned it rather than acting twice. That is deduplication working — the '
          + 'same logical action is one action however many times you ask. To perform a NEW removal after '
          + 're-adding someone, change something in the inputs so the business key differs.</p>'
        : "")
      + (result.action && result.action.action_id
        ? '<p class="small gap-m"><a href="/actions/' + text(result.action.action_id) + '">Open the full record →</a>'
          + ' Evidence, the facts used, and the signed receipt.</p>'
        : "")
      + '</div>';
    panel.scrollIntoView({ block: "nearest" });
  }

  /**
   * CONNECT A PROVIDER (v0.3.3).
   *
   * The one form in the product whose field contains a real secret. So:
   * the input is CLEARED the moment the request is issued, whatever the
   * outcome, and the value is never written anywhere else — not to a dataset
   * attribute, not to sessionStorage, not into the note text on failure.
   */
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-connect-provider]");
    if (!form) return;
    event.preventDefault();
    const provider = form.dataset.connectProvider;
    const field = form.querySelector("input[name=credential]");
    const button = form.querySelector("button");
    const credential = field.value;
    // Cleared before the await, so a slow network never leaves a token sitting
    // in a visible field on an unattended screen.
    field.value = "";
    const result = await send(button, "POST", "/v1/integrations/" + provider + "/credential", { credential });
    if (!result) return;
    announce(button, "Stored (" + result.fingerprint + "). " + result.next_step, false);
    // Storing is not verifying. Run the read-only preflight immediately so the
    // customer finds out now whether the credential actually works, rather than
    // discovering it during their first real action.
    const preflight = await send(button, "POST", "/v1/integrations/" + provider + "/preflight", {});
    if (preflight) location.reload();
  });
})();
`;
