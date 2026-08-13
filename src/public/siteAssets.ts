/**
 * PUBLIC SITE ASSETS.
 *
 * The motion system is the product's vocabulary made visible:
 *
 *   KNOWN     solid line, filled node
 *   UNKNOWN   dashed line, open node, a very slow pulse
 *   BLOCKED   the line terminates against a perpendicular control bar
 *   RESOLVED  dashed becomes solid, open becomes filled, 250-400ms
 *   EVIDENCE  a point travels from the source into the causal node
 *
 * Served as real files with a Content-Security-Policy that forbids inline
 * script and inline style, which is why none of this is in an attribute. That
 * constraint already caught a whole class of bug in this codebase once.
 *
 * NOTHING HERE MAY BLOCK A VISITOR. No wheel handler, no scroll hijack, no
 * pointer-events blocking, no forced timeline. Scenes animate on intersection,
 * so scrolling fast skips them rather than queueing them, browser back works,
 * and with JavaScript off every scene renders in its final state.
 */

export const SITE_CSS = `
:root {
  --ink: #14171B; --ink-muted: #5A6270; --cream: #FBFAF7; --cream-deep: #F4F2EC;
  --navy: #1B2A4A; --navy-soft: #46587E;
  --resolved: #1F6B45; --resolved-bg: #EAF3ED;
  --uncertain: #8A6516; --uncertain-bg: #FBF0DC;
  --blocked: #9B2C34; --blocked-bg: #FBEBEC;
  --rule: #E3DFD5; --rule-strong: #CFC9BA; --focus: #3465A4;
  --measure: 68ch;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body.site {
  margin: 0; background: var(--cream); color: var(--ink);
  font: 16px/1.6 ui-serif, Georgia, "Times New Roman", serif;
}
h1, h2, h3, .wordmark, .eyebrow { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 16px; }
h2 { font-size: clamp(1.4rem, 3vw, 2.1rem); line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 12px; }
p { margin: 0 0 14px; max-width: var(--measure); }
a { color: var(--navy); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--focus); outline-offset: 3px;
}
.small { font-size: 0.88rem; color: var(--ink-muted); }
.eyebrow { font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin: 0 0 6px; }
.lede { font-size: 1.12rem; color: var(--ink-muted); }

/* The skip link is real and reachable on the first Tab, before anything else. */
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 12px; top: 12px; z-index: 100; background: var(--cream); padding: 10px 14px; border: 1px solid var(--rule-strong); }

/* ---------------------------------------------------------------- nav */
/* Static, in normal flow, never covered by a scene. */
.site-nav {
  display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
  padding: 14px 28px; border-bottom: 1px solid var(--rule);
  background: var(--cream); position: sticky; top: 0; z-index: 20;
}
.site-brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--ink); font-weight: 600; }
.site-brand span { font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.01em; }
.site-nav nav { display: flex; gap: 18px; flex: 1 1 auto; flex-wrap: wrap; }
.site-nav nav a { text-decoration: none; color: var(--ink-muted); font-size: 0.95rem; }
.site-nav nav a:hover, .site-nav nav a[aria-current="page"] { color: var(--ink); }
.site-cta { display: flex; gap: 10px; align-items: center; }
/* Someone who already uses Nyst should reach their work from the header,
   not by scrolling a marketing page to find a footer link. */
.site-signin { color: var(--ink-muted); text-decoration: none; font-size: 0.95rem;
  font-family: ui-sans-serif, system-ui, sans-serif; padding: 9px 4px; }
.site-signin:hover { color: var(--ink); }
.button {
  display: inline-block; padding: 9px 16px; border-radius: 8px; text-decoration: none;
  border: 1px solid var(--rule-strong); background: var(--cream-deep); color: var(--ink);
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.92rem; cursor: pointer;
}
.button.primary { background: var(--navy); border-color: var(--navy); color: #fff; }
.button.subtle { background: transparent; }

/* --------------------------------------------------------------- hero */
.hero { padding: 72px 28px 48px; max-width: 900px; margin: 0 auto; text-align: center; }
.hero-mark { color: var(--navy); }
.loop { width: 92px; height: 92px; }
/* The logo does NOT spin. The single trace below runs once, on load, and only
   because a loop mark that never moves at all reads as a static image. */
.loop-path { stroke-dasharray: 1 0; }
@media (prefers-reduced-motion: no-preference) {
  .loop-path { stroke-dasharray: 300; stroke-dashoffset: 300; animation: trace 1400ms ease-out forwards; }
}
@keyframes trace { to { stroke-dashoffset: 0; } }
.wordmark { font-size: 2.6rem; font-weight: 600; letter-spacing: -0.02em; margin: 12px 0 4px; }
.devanagari { font-size: 2rem; margin: 0 0 2px; color: var(--navy); }
.translit { font-size: 1.05rem; color: var(--ink-muted); font-style: italic; margin: 0 0 6px; }
.gloss { color: var(--ink-muted); margin: 0 auto 8px; }
.gloss-note { max-width: 54ch; margin: 0 auto 40px; color: var(--ink); }
.hero p { margin-left: auto; margin-right: auto; }
.hero-cta { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin: 24px 0 8px; }
.hero-note { max-width: 52ch; margin: 0 auto; }

/* -------------------------------------------------------------- story */
.story { border-top: 1px solid var(--rule); }
.scene {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; align-items: center;
  padding: 96px 28px; max-width: 1100px; margin: 0 auto; border-bottom: 1px solid var(--rule);
}
.scene:nth-child(even) .scene-copy { order: 2; }
.scene-figure { min-height: 160px; display: flex; flex-direction: column; gap: 14px; justify-content: center; }

/* Scenes render in their FINAL state by default. The observer only adds the
   transition-in; with JavaScript off, nothing is hidden. */
@media (prefers-reduced-motion: no-preference) {
  .scene[data-observed="pending"] .scene-copy,
  .scene[data-observed="pending"] .scene-figure { opacity: 0.001; transform: translateY(14px); }
  .scene .scene-copy, .scene .scene-figure { transition: opacity 320ms ease-out, transform 320ms ease-out; }
}

/* KNOWN / UNKNOWN / BLOCKED, the vocabulary made visible. */
.cnode { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--rule-strong); border-radius: 10px; background: var(--cream-deep); }
.cnode .dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--navy); }
.state-known .dot { background: var(--navy); }
.state-unknown .dot { background: transparent; }
.state-absent { opacity: 0.45; }
.state-absent .dot { border-style: dashed; }
@media (prefers-reduced-motion: no-preference) {
  .state-unknown .dot { animation: breathe 3200ms ease-in-out infinite; }
}
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.trace { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; color: var(--ink-muted); flex-wrap: wrap; }
.trace .line { flex: 1 1 40px; height: 0; border-top: 2px solid var(--navy); min-width: 40px; }
.trace-dashed .line { border-top-style: dashed; }
.trace .from, .trace .via, .trace .to { padding: 4px 8px; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--cream-deep); }

.uncertainty { display: flex; align-items: center; gap: 8px; color: var(--uncertain); font-size: 0.9rem; }
.open-node { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--uncertain); }

.control-bar { border-left: 4px solid var(--blocked); background: var(--blocked-bg); padding: 12px 16px; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.06em; }
.control-bar.hold { border-left-color: var(--uncertain); background: var(--uncertain-bg); }
.reason { font-size: 0.9rem; color: var(--ink-muted); }

.evidence-point { display: flex; align-items: center; gap: 10px; }
.evidence-point span { width: 10px; height: 10px; border-radius: 50%; background: var(--resolved); }
@media (prefers-reduced-motion: no-preference) {
  .scene[data-observed="seen"] .evidence-point span { animation: arrive 420ms ease-out; }
}
@keyframes arrive { from { transform: translateX(-28px); opacity: 0; } to { transform: none; opacity: 1; } }
.evidence-point p { margin: 0; font-size: 0.92rem; }

.required-outcome { border: 1px solid var(--rule-strong); border-radius: 12px; padding: 18px; background: var(--cream-deep); }
.branches { display: flex; flex-direction: column; gap: 10px; }

.reveal { display: flex; flex-direction: column; gap: 12px; }
.claim { margin: 0; padding: 14px 16px; border-radius: 10px; border-left: 4px solid var(--rule-strong); background: var(--cream-deep); }
.claim strong { display: block; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; }
.claim span { font-size: 0.92rem; color: var(--ink-muted); }
.claim-ok { border-left-color: var(--resolved); background: var(--resolved-bg); }
.claim-alarm { border-left-color: var(--blocked); background: var(--blocked-bg); }

.outcome-node { border: 2px solid var(--resolved); background: var(--resolved-bg); border-radius: 12px; padding: 18px; text-align: center; }
.outcome-node span { display: block; font-size: 0.75rem; letter-spacing: 0.12em; color: var(--ink-muted); }
.outcome-node strong { font-size: 1.4rem; font-family: ui-sans-serif, system-ui, sans-serif; }
.grant, .receipt { border: 1px solid var(--navy-soft); border-radius: 10px; padding: 14px 16px; background: var(--cream-deep); }
.grant span, .receipt span { font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 600; }

/* --------------------------------------------------------------- pages */
.page-head-public { max-width: 900px; margin: 0 auto; padding: 64px 28px 24px; }
.band { max-width: 900px; margin: 0 auto; padding: 56px 28px; border-top: 1px solid var(--rule); }
.band-quiet { background: var(--cream-deep); max-width: none; }
.band-quiet > * { max-width: 900px; margin-left: auto; margin-right: auto; }
.layers { max-width: 1100px; margin: 0 auto; padding: 24px 28px 56px; display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.layer { border: 1px solid var(--rule); border-radius: 12px; padding: 20px; background: var(--cream-deep); }
.guarantees { max-width: var(--measure); padding-left: 20px; }
.guarantees li { margin-bottom: 10px; }

.plans { max-width: 1200px; margin: 0 auto; padding: 24px 28px 56px; display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.plan { border: 1px solid var(--rule); border-radius: 12px; padding: 22px; background: var(--cream-deep); display: flex; flex-direction: column; }
.plan-featured { border-color: var(--navy); border-width: 2px; background: var(--cream); }
.plan-price { font-size: 1.5rem; font-family: ui-sans-serif, system-ui, sans-serif; margin: 0 0 4px; }
.plan-price span { display: block; font-size: 0.85rem; color: var(--ink-muted); }
.plan-summary { font-size: 0.95rem; }
.plan ul { padding-left: 20px; margin: 0 0 16px; font-size: 0.92rem; }
.plan li { margin-bottom: 6px; }
.plan-excludes { color: var(--ink-muted); border-top: 1px solid var(--rule); padding-top: 10px; }
.plan .button { margin-top: auto; text-align: center; }

.configure { max-width: 720px; margin: 0 auto; padding: 24px 28px 64px; }
.steps { display: flex; flex-direction: column; gap: 20px; }
.step { border: 1px solid var(--rule); border-radius: 12px; padding: 20px; background: var(--cream-deep); }
.step legend { font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 600; padding: 0 6px; }
.step label { display: block; margin-bottom: 14px; font-size: 0.95rem; }
.step label.check { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.step input[type="text"], .step input[type="email"], .step input[type="number"], .step select, .step textarea {
  display: block; width: 100%; margin-top: 6px; padding: 9px 10px;
  border: 1px solid var(--rule-strong); border-radius: 8px; background: var(--cream); font: inherit;
}
.step-actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.quote { max-width: 720px; margin: 0 auto; padding: 24px 28px; border: 2px solid var(--navy); border-radius: 12px; background: var(--cream-deep); }
.rationale, .uncovered ul { padding-left: 20px; }
.uncovered { border-top: 1px solid var(--rule); margin-top: 16px; padding-top: 12px; }
.uncovered h3 { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 1rem; }

.site-foot { border-top: 1px solid var(--rule); padding: 40px 28px; display: flex; gap: 32px; flex-wrap: wrap; justify-content: space-between; background: var(--cream-deep); }
.site-foot nav { display: flex; gap: 16px; flex-wrap: wrap; }
.site-foot nav a { color: var(--ink-muted); text-decoration: none; font-size: 0.9rem; }

@media (max-width: 860px) {
  .scene { grid-template-columns: 1fr; gap: 24px; padding: 56px 20px; }
  .scene:nth-child(even) .scene-copy { order: 0; }
  .site-nav { gap: 12px; padding: 12px 18px; }
  .site-nav nav { order: 3; flex-basis: 100%; }
  .hero { padding: 48px 20px 32px; }
}
`;

/**
 * The site script.
 *
 * Twenty lines, and every one of them is additive. There is no wheel listener,
 * no scroll listener, no requestAnimationFrame loop and no history
 * manipulation. If this file fails to load, the site is identical minus the
 * fade-in.
 */
export const SITE_JS = `
(function () {
  "use strict";
  // Respect the setting rather than reading it once and hoping.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  var scenes = document.querySelectorAll(".scene");
  if (!scenes.length) return;

  // Mark pending only now, from script. Before this runs — and forever, if it
  // never does — every scene is in its final, fully readable state.
  for (var i = 0; i < scenes.length; i++) scenes[i].setAttribute("data-observed", "pending");

  var observer = new IntersectionObserver(function (entries) {
    for (var j = 0; j < entries.length; j++) {
      if (!entries[j].isIntersecting) continue;
      entries[j].target.setAttribute("data-observed", "seen");
      // One-way. A scene never animates out, so scrolling back up is instant
      // and browser back lands on a page that is already readable.
      observer.unobserve(entries[j].target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });

  for (var k = 0; k < scenes.length; k++) observer.observe(scenes[k]);
})();
`;
