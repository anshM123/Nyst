/**
 * NYST DESIGN SYSTEM (Phase 24).
 *
 * A premium infrastructure control plane, not an AI dashboard template.
 *
 * Palette is taken from the brand mark: deep navy #10275F on warm cream
 * #F7F2E9, with white working surfaces and warm-grey rules. Semantic colour is
 * reserved for meaning — green resolved, amber uncertain, red blocked — and is
 * never decorative. There is no purple, no gradient, no glassmorphism, no glow,
 * and no sparkle iconography anywhere in this file.
 *
 * Character: precise typography, thin rules, controlled density, excellent
 * tables and timelines, few strong sections rather than a grid of equal cards.
 * Motion exists only to communicate a real state change, and is disabled
 * entirely under `prefers-reduced-motion`.
 */

export const NYST_CSS = `
/* ============================================================ tokens */
:root {
  --navy: #10275F;
  --navy-700: #1B357A;
  --navy-300: #6779A8;
  --ink: #101728;
  --ink-muted: #55607A;
  --ink-faint: #7C869B;
  --cream: #F7F2E9;
  --cream-deep: #EFE7D9;
  --surface: #FFFFFF;
  --surface-warm: #FCFAF6;
  --rule: #E3DCCE;
  --rule-strong: #CFC5B2;

  /* Semantic only. Never used for decoration. */
  --resolved: #1F6B45;
  --resolved-bg: #E9F3ED;
  --uncertain: #8A5B00;
  --uncertain-bg: #FBF0DC;
  --blocked: #A22030;
  --blocked-bg: #FBEAEC;

  --radius: 6px;
  --radius-lg: 10px;
  --shadow-card: 0 1px 2px rgba(16, 39, 95, .06), 0 1px 1px rgba(16, 39, 95, .04);
  --shadow-raised: 0 8px 24px rgba(16, 39, 95, .10), 0 2px 6px rgba(16, 39, 95, .06);

  --sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;

  --nav-width: 232px;
  --measure: 68ch;
}

*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  max-width: 100%;
  /* Deliberately NOT overflow-x: hidden. Clipping the root would make a real
     layout overflow invisible instead of absent, and the half of a table that
     scrolled off a phone would simply be unreachable. Wide content is made to
     scroll inside its own container (.table-scroll) instead. */
}

body {
  margin: 0;
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
  color: var(--ink);
  background: var(--cream);
  /* Nothing may push the page sideways; wide content scrolls inside its own box. */
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4 { margin: 0; font-weight: 620; letter-spacing: -0.014em; color: var(--ink); line-height: 1.25; }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.12rem; }
h3 { font-size: .96rem; }
p { margin: 0; }
a { color: var(--navy); text-decoration-color: var(--navy-300); text-underline-offset: 2px; }
a:hover { color: var(--navy-700); }
code, .mono { font-family: var(--mono); font-size: .86em; font-variant-ligatures: none; }

.eyebrow {
  font-size: .68rem; font-weight: 680; letter-spacing: .1em; text-transform: uppercase;
  color: var(--ink-faint);
}
.lede { color: var(--ink-muted); max-width: var(--measure); }
small, .small { font-size: .8rem; color: var(--ink-muted); }
.empty { color: var(--ink-faint); font-style: normal; padding: 18px 0; }

/* Accessible focus, always visible, never removed. */
:focus-visible {
  outline: 2px solid var(--navy);
  outline-offset: 2px;
  border-radius: 3px;
}

/* Available to screen readers, removed from the visual layout. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip-link {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--navy); color: #fff; padding: 10px 16px; border-radius: 0 0 var(--radius) 0;
}
.skip-link:focus { left: 0; }

/* ============================================================ shell */
.shell { display: grid; grid-template-columns: var(--nav-width) minmax(0, 1fr); min-height: 100vh; }

.sidebar {
  background: var(--navy);
  color: #E8EBF4;
  display: flex; flex-direction: column;
  padding: 20px 14px;
  position: sticky; top: 0; height: 100vh;
}
/* The mark is a link to Overview. Clicking a product logo to get home is the
   one navigation convention every person already has, so it must be real. */
.brand {
  display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px;
  text-decoration: none; color: inherit; border-radius: var(--radius);
}
.brand:hover span { color: #fff; }
.brand img { width: 26px; height: 26px; display: block; }
/* The product is called Nyst. The .ai lockup is reserved for external identity. */
.brand span { font-size: 1.02rem; font-weight: 640; letter-spacing: -0.01em; color: #fff; }

.nav { display: flex; flex-direction: column; gap: 1px; }
.nav a {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; border-radius: var(--radius);
  color: #C7CFE4; text-decoration: none; font-size: .875rem; font-weight: 500;
}
.nav a:hover { background: rgba(255,255,255,.07); color: #fff; }
.nav a[aria-current="page"] { background: rgba(255,255,255,.13); color: #fff; font-weight: 600; }
.nav .count {
  font-family: var(--mono); font-size: .72rem; padding: 1px 6px; border-radius: 20px;
  background: var(--uncertain); color: #241700; font-weight: 700;
}
.nav-group { margin-top: 18px; padding: 0 10px 6px; font-size: .66rem; letter-spacing: .1em; text-transform: uppercase; color: #8494BD; font-weight: 700; }
.sidebar-foot { margin-top: auto; padding: 14px 10px 0; border-top: 1px solid rgba(255,255,255,.12); font-size: .76rem; color: #93A0C4; }
.sidebar-foot a { color: #C7CFE4; }

/* A second route home, always visible in the topbar. The sidebar rail scrolls
   horizontally on a phone, so "Overview" can be off-screen there. */
.topbar-home {
  font-size: .8rem; font-weight: 560; text-decoration: none;
  color: var(--navy); border: 1px solid var(--rule); background: var(--surface);
  border-radius: var(--radius); padding: 5px 11px; white-space: nowrap;
}
.topbar-home:hover { background: var(--cream); }

.main { min-width: 0; max-width: 100%; display: flex; flex-direction: column; }

.topbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 12px 28px; background: var(--surface); border-bottom: 1px solid var(--rule);
  position: sticky; top: 0; z-index: 20;
}
.topbar .context { display: flex; align-items: center; gap: 8px; font-size: .84rem; color: var(--ink-muted); min-width: 0; }
.topbar .context strong { color: var(--ink); font-weight: 600; }
.topbar .spacer { flex: 1 1 auto; }

.content { padding: 26px 28px 64px; max-width: 1180px; width: 100%; min-width: 0; }

/* ============================================================ freeze banner */
/* Serious, not theatrical. It is a statement of fact, not an alarm. */
.freeze-banner {
  display: flex; gap: 14px; align-items: flex-start;
  background: var(--blocked-bg); border: 1px solid var(--blocked);
  border-left-width: 4px; border-radius: var(--radius);
  padding: 14px 16px; margin-bottom: 22px;
}
.freeze-banner h2 { color: var(--blocked); font-size: 1rem; }
.freeze-banner p { color: #6B1A25; font-size: .86rem; margin-top: 3px; }
.freeze-banner dl { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 8px 0 0; font-size: .8rem; }
.freeze-banner dt { color: #8A2A38; font-weight: 600; display: inline; }
.freeze-banner dd { margin: 0 0 0 5px; display: inline; color: #6B1A25; }

/* ============================================================ sections */
.page-head { margin-bottom: 22px; }
.page-head h1 { margin-bottom: 4px; }

.section { margin-top: 30px; min-width: 0; }
.section-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding-bottom: 9px; margin-bottom: 14px; border-bottom: 1px solid var(--rule);
}
.section-head h2 { font-size: 1.02rem; }
.section-head .eyebrow { margin-bottom: 2px; }
.section-head a { font-size: .82rem; text-decoration: none; font-weight: 550; white-space: nowrap; }
.section-head a:hover { text-decoration: underline; }

.panel {
  min-width: 0;
  background: var(--surface); border: 1px solid var(--rule);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-card);
}
.panel-pad { padding: 18px 20px; }

/* ============================================================ headline */
/* One strong statement, not twelve equal cards. */
.headline {
  background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius-lg);
  padding: 24px 26px; box-shadow: var(--shadow-card);
  display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 20px; align-items: center;
}
.headline h1 { font-size: 1.72rem; letter-spacing: -0.02em; }
.headline .lede { margin-top: 6px; font-size: .92rem; }
.headline .mode-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }

.metrics {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(168px, 100%), 1fr));
  border: 1px solid var(--rule); border-radius: var(--radius-lg); overflow: hidden;
  background: var(--surface); margin-top: 16px;
}
.metric { padding: 15px 18px; border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.metric:last-child { border-right: 0; }
.metric .label { font-size: .74rem; font-weight: 620; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-faint); }
.metric .value { font-size: 1.9rem; font-weight: 640; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; margin-top: 2px; color: var(--ink); }
.metric .note { font-size: .76rem; color: var(--ink-muted); margin-top: 3px; display: block; }
.metric.is-primary { background: var(--surface-warm); }
.metric.is-primary .value { color: var(--navy); }

/* ============================================================ disclosure */
/* Progressive disclosure for detail that would otherwise bury the summary. */
details { border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; background: var(--cream-deep); }
details + details { margin-top: 10px; }
details > summary { cursor: pointer; font-weight: 600; font-size: 0.92rem; }
details > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 4px; }
details[open] > summary { margin-bottom: 10px; }

/* ============================================================ badges */
/* Status is never colour-only: every badge carries a text label. */
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: .73rem; font-weight: 640; letter-spacing: .02em;
  padding: 2px 8px; border-radius: 20px; border: 1px solid transparent; white-space: nowrap;
}
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.badge.resolved { color: var(--resolved); background: var(--resolved-bg); border-color: #BFDCCB; }
.badge.uncertain { color: var(--uncertain); background: var(--uncertain-bg); border-color: #E8D3A8; }
.badge.blocked { color: var(--blocked); background: var(--blocked-bg); border-color: #EDC3C9; }
.badge.neutral { color: var(--ink-muted); background: var(--cream-deep); border-color: var(--rule-strong); }

.mode {
  display: inline-flex; align-items: center; font-size: .7rem; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; padding: 3px 9px; border-radius: 4px; border: 1px solid;
}
.mode.shadow { color: var(--ink-muted); background: var(--cream-deep); border-color: var(--rule-strong); }
.mode.canary { color: var(--uncertain); background: var(--uncertain-bg); border-color: #E8D3A8; }
.mode.enforced { color: var(--navy); background: #E9EDF7; border-color: #C3CCE4; }
.mode.protected { color: var(--resolved); background: var(--resolved-bg); border-color: #BFDCCB; }
.mode.frozen { color: var(--blocked); background: var(--blocked-bg); border-color: #EDC3C9; }

/* ============================================================ tables */
.table-scroll {
  /* A wide table scrolls INSIDE this box. The box itself is pinned to the
     width of its container and never grows to fit its contents. */
  display: block; width: 100%; max-width: 100%; min-width: 0;
  overflow-x: auto; -webkit-overflow-scrolling: touch;
  border: 1px solid var(--rule); border-radius: var(--radius-lg); background: var(--surface);
}
/* Without this the table shrinks to the box instead of scrolling, and the
   columns become unreadable. */
.table-scroll > table { min-width: max-content; }
table { width: 100%; border-collapse: collapse; font-size: .86rem; }
thead th {
  text-align: left; font-size: .71rem; font-weight: 660; letter-spacing: .06em; text-transform: uppercase;
  color: var(--ink-faint); padding: 9px 14px; background: var(--surface-warm);
  border-bottom: 1px solid var(--rule); white-space: nowrap; position: sticky; top: 0;
}
tbody td { padding: 11px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-warm); }
td .sub { display: block; font-size: .78rem; color: var(--ink-muted); margin-top: 2px; }
td.numeric { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }

/* ============================================================ timeline */
.timeline { list-style: none; margin: 0; padding: 0 0 0 22px; position: relative; }
.timeline::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 1px; background: var(--rule-strong); }
.timeline li { position: relative; padding: 0 0 18px; }
.timeline li:last-child { padding-bottom: 0; }
.timeline li::before {
  content: ""; position: absolute; left: -21px; top: 5px; width: 11px; height: 11px;
  border-radius: 50%; background: var(--surface); border: 2px solid var(--navy-300);
}
.timeline li.is-key::before { border-color: var(--navy); background: var(--navy); }
.timeline li.is-blocked::before { border-color: var(--blocked); background: var(--blocked); }
.timeline .when { font-family: var(--mono); font-size: .74rem; color: var(--ink-faint); }
.timeline .what { font-weight: 600; font-size: .88rem; margin-top: 1px; }
.timeline .detail { font-size: .82rem; color: var(--ink-muted); margin-top: 2px; max-width: var(--measure); }

/* ============================================================ decision */
/* The "why did Nyst decide this?" block — the hero of Action Detail. */
.decision {
  border: 1px solid var(--rule); border-left: 4px solid var(--navy);
  border-radius: var(--radius-lg); background: var(--surface); padding: 20px 22px;
}
.decision .verdict { font-size: 1.28rem; font-weight: 660; letter-spacing: -0.015em; color: var(--navy); }
.decision .because { margin-top: 12px; display: flex; flex-direction: column; gap: 7px; }
.decision .because li { list-style: none; padding-left: 20px; position: relative; font-size: .9rem; color: var(--ink); max-width: var(--measure); }
.decision .because li::before { content: ""; position: absolute; left: 3px; top: .55em; width: 7px; height: 1px; background: var(--rule-strong); }
.decision ul { margin: 0; padding: 0; }
.decision .therefore { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 10px 26px; }
.decision .therefore div { min-width: 120px; }
.decision .therefore dt { font-size: .71rem; font-weight: 660; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-faint); }
.decision .therefore dd { margin: 2px 0 0; font-weight: 600; font-size: .92rem; }
.decision.is-blocked { border-left-color: var(--blocked); }
.decision.is-blocked .verdict { color: var(--blocked); }
.decision.is-uncertain { border-left-color: var(--uncertain); }
.decision.is-uncertain .verdict { color: var(--uncertain); }

/* ============================================================ facts */
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 12px 22px; margin: 0; min-width: 0; }
.facts > div { min-width: 0; }
.facts dt { font-size: .71rem; font-weight: 640; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-faint); }
.facts dd { margin: 2px 0 0; font-size: .89rem; overflow-wrap: anywhere; }

/* ============================================================ incidents */
.incident {
  min-width: 0; overflow-wrap: anywhere;
  border: 1px solid var(--rule); border-radius: var(--radius-lg); background: var(--surface);
  padding: 18px 20px; margin-bottom: 12px; border-left: 3px solid var(--uncertain);
}
.incident.is-blocked { border-left-color: var(--blocked); }
.incident header { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.incident h3 { font-size: 1rem; }
.incident .meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; font-size: .8rem; color: var(--ink-muted); }
.incident .knowledge { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; margin-top: 14px; }
.incident .knowledge h4 { font-size: .73rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-faint); }
.incident .knowledge ul { margin: 5px 0 0; padding-left: 17px; font-size: .84rem; color: var(--ink); }
.incident .knowledge li { margin-bottom: 3px; }
.incident .actions { margin-top: 15px; padding-top: 13px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 8px; }

/* ============================================================ controls */
button, .button {
  font: inherit; font-size: .85rem; font-weight: 560;
  padding: 7px 14px; border-radius: var(--radius); border: 1px solid var(--rule-strong);
  background: var(--surface); color: var(--ink); cursor: pointer; text-decoration: none;
  display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
}
button:hover:not(:disabled), .button:hover { background: var(--surface-warm); border-color: var(--navy-300); }
button.primary, .button.primary { background: var(--navy); border-color: var(--navy); color: #fff; }
button.primary:hover:not(:disabled) { background: var(--navy-700); border-color: var(--navy-700); }
button.danger { background: var(--blocked); border-color: var(--blocked); color: #fff; }
button.danger:hover:not(:disabled) { background: #8C1B29; }
button.subtle { background: transparent; border-color: transparent; color: var(--navy); padding-inline: 8px; }
/* A disabled control must always explain itself; never a dead button. */
button:disabled, .button[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
button[data-busy="true"] { opacity: .65; cursor: progress; }

.button-row { display: flex; flex-wrap: wrap; gap: 8px; }

label { display: block; font-size: .8rem; font-weight: 600; color: var(--ink); margin-bottom: 12px; }
input, select, textarea {
  font: inherit; font-size: .88rem; width: 100%; margin-top: 4px;
  padding: 8px 11px; border: 1px solid var(--rule-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--ink);
}
input:focus, select:focus, textarea:focus { border-color: var(--navy); }
fieldset { border: 1px solid var(--rule); border-radius: var(--radius); padding: 14px 16px; margin: 0 0 16px; }
legend { font-size: .78rem; font-weight: 660; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-faint); padding: 0 6px; }

[role="alert"] { color: var(--blocked); font-size: .84rem; }
[role="status"] { color: var(--resolved); font-size: .84rem; }

/* ============================================================ flow */
.flow { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
.flow .node {
  flex: 1 1 150px; min-width: 0; padding: 16px 18px; background: var(--surface);
  border: 1px solid var(--rule); border-right: 0; text-align: left;
}
.flow .node:first-child { border-radius: var(--radius-lg) 0 0 var(--radius-lg); }
.flow .node:last-child { border-right: 1px solid var(--rule); border-radius: 0 var(--radius-lg) var(--radius-lg) 0; }
.flow .node .step { font-family: var(--mono); font-size: .7rem; color: var(--ink-faint); }
.flow .node strong { display: block; font-size: .95rem; margin-top: 3px; }
.flow .node small { display: block; margin-top: 3px; }
.flow .node.is-nyst { background: var(--navy); border-color: var(--navy); }
.flow .node.is-nyst .step, .flow .node.is-nyst small { color: #A9B6D8; }
.flow .node.is-nyst strong { color: #fff; }
.flow .node.is-fault { border-color: var(--blocked); background: var(--blocked-bg); }

/* ============================================================ compare */
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 16px; }
.compare > div { min-width: 0; overflow-wrap: anywhere; }
.compare > div { border: 1px solid var(--rule); border-radius: var(--radius-lg); padding: 16px 18px; background: var(--surface); }
.compare .naive { border-color: #EDC3C9; background: var(--blocked-bg); }
.compare h3 { font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); }
.compare ol { margin: 9px 0 0; padding-left: 19px; font-size: .86rem; }
.compare li { margin-bottom: 4px; }

/* ============================================================ rollout */
.rollout { display: flex; align-items: center; gap: 0; flex-wrap: wrap; margin-top: 4px; }
.rollout .stage {
  flex: 1 1 120px; padding: 12px 16px; border: 1px solid var(--rule); border-right: 0;
  background: var(--surface); position: relative;
}
.rollout .stage:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.rollout .stage:last-child { border-right: 1px solid var(--rule); border-radius: 0 var(--radius) var(--radius) 0; }
.rollout .stage .name { font-size: .74rem; font-weight: 680; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); }
.rollout .stage .desc { font-size: .8rem; color: var(--ink-muted); margin-top: 3px; }
.rollout .stage.is-current { background: var(--navy); border-color: var(--navy); }
.rollout .stage.is-current .name { color: #fff; }
.rollout .stage.is-current .desc { color: #B9C4E0; }
.rollout .stage.is-done { background: var(--surface-warm); }

/* ============================================================ checks */
.checks { list-style: none; margin: 0; padding: 0; }
.checks li { display: flex; gap: 11px; padding: 10px 0; border-bottom: 1px solid var(--rule); align-items: flex-start; }
.checks li:last-child { border-bottom: 0; }
.checks .state { font-size: .72rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; flex: 0 0 74px; padding-top: 1px; }
.checks .state.pass { color: var(--resolved); }
.checks .state.fail { color: var(--blocked); }
.checks .state.info { color: var(--ink-faint); }
.checks .body { min-width: 0; overflow-wrap: anywhere; }
.checks .body strong { display: block; font-size: .88rem; }
.checks .body span { display: block; font-size: .82rem; color: var(--ink-muted); margin-top: 1px; max-width: var(--measure); }

/* ============================================================ login */
.login { display: grid; grid-template-columns: 1.15fr 1fr; min-height: 100vh; }
.login-brand { background: var(--navy); color: #fff; padding: 56px 48px; display: flex; flex-direction: column; justify-content: center; }
.login-brand img { width: 190px; max-width: 60%; margin-bottom: 32px; }
.login-brand h1 { color: #fff; font-size: 2rem; letter-spacing: -0.025em; }
.login-brand p { color: #B9C4E0; margin-top: 14px; max-width: 44ch; }
.login-brand .eyebrow { color: #8494BD; margin-bottom: 10px; }
.login-card { padding: 56px 48px; display: flex; flex-direction: column; justify-content: center; background: var(--cream); }
.login-card form { max-width: 340px; width: 100%; }
.login-card h2 { margin-bottom: 20px; }
.login-card button { width: 100%; justify-content: center; margin-top: 6px; }

/* ============================================================ document */
/* Print-quality standalone documents (Protection Report, Proof Pack). */
.document { background: var(--surface); }
.document .proof-pack, .document .report { max-width: 940px; margin: 0 auto; padding: 40px 32px 80px; }
.document h1 { font-size: 1.75rem; }
.document section { margin-top: 30px; }
.document section h2 {
  font-size: 1rem; padding-bottom: 7px; border-bottom: 1px solid var(--rule); margin-bottom: 13px;
}
.document .scroll { overflow-x: auto; }
.document .state { font-size: 1.05rem; }
.document ul { padding-left: 19px; font-size: .87rem; color: var(--ink-muted); }
.document li { margin-bottom: 5px; }

@media print {
  .sidebar, .topbar, .button-row, button { display: none !important; }
  body { background: #fff; }
  .content, .document .proof-pack, .document .report { padding: 0; max-width: none; }
  .panel, .table-scroll, .decision, .headline { box-shadow: none; border-color: #BBB; break-inside: avoid; }
  .section { break-inside: avoid; }
  a { text-decoration: none; color: #000; }
}

/* ============================================================ utilities

   These exist because the Content-Security-Policy is style-src 'self', so an
   inline style="" attribute is BLOCKED and silently does nothing. Every layout
   declaration therefore has to live in this stylesheet, which is same-origin
   and allowed. Keep it that way: an inline style added later will not apply,
   and the failure is invisible unless you read the console. */
.gap-s { margin-top: 10px; }
.gap-m { margin-top: 12px; }
.gap-l { margin-top: 14px; }
.gap-xl { margin-top: 16px; }
.gap-below-m { margin-bottom: 12px; }
.gap-below-l { margin-bottom: 16px; }
.gap-below-xl { margin-bottom: 18px; }
.gap-below-xl-top { margin-top: 18px; }
.aside-note { margin-top: 6px; font-size: .86rem; }
.divided { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule); }
.split { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.split-top { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.field-end { display: flex; align-items: end; padding-bottom: 12px; }
.field-end-row { display: flex; align-items: end; gap: 8px; padding-bottom: 12px; }
.field-grid {
  border: 0; padding: 0; margin: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 0 16px;
}
.field-grid-wide { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 0 16px; }
.pre-scroll { overflow: auto; font-size: .77rem; }
.bullets { margin: 0; padding-left: 19px; color: var(--ink-muted); font-size: .87rem; }
.bullets-plain { margin: 0; padding-left: 19px; }
.clickable { cursor: pointer; }
.ok-text { color: var(--resolved); }
.context-select { width: auto; margin: 0; }
/* Inline note appended by the client script after a mutating call. */
.note { flex-basis: 100%; margin-top: 8px; font-size: .84rem; }
.note.error { color: var(--blocked); }

/* ============================================================ responsive */
@media (max-width: 900px) {
  /* minmax(0, 1fr), never plain 1fr: a plain 1fr track has min-width auto, so
     a wide table forces the whole PAGE to scroll sideways instead of scrolling
     inside its own container. */
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    position: static; height: auto; flex-direction: column; padding: 12px 14px;
  }
  .brand { padding-bottom: 12px; }
  /* Navigation collapses into a horizontally scrollable rail, so it stays
     usable on a phone without a hamburger that hides the incident count. */
  .nav { flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; scrollbar-width: thin; }
  .nav a { white-space: nowrap; padding: 6px 12px; }
  .nav-group, .sidebar-foot { display: none; }
  .topbar { padding: 10px 16px; position: static; }
  .content { padding: 18px 16px 56px; max-width: 100vw; }
  .headline { grid-template-columns: 1fr; padding: 20px; }
  .headline .mode-stack { flex-direction: row; align-items: center; }
  .login { grid-template-columns: 1fr; }
  .login-brand { padding: 36px 24px; }
  .login-brand img { width: 150px; }
  .login-card { padding: 32px 24px; }
  .metric { border-right: 0; }
  .flow .node, .rollout .stage { border-right: 1px solid var(--rule); border-radius: var(--radius) !important; flex-basis: 100%; }
  .flow, .rollout { gap: 8px; }
  /* Filter and form grids collapse to one column rather than forcing width. */
  form[aria-label="Filter actions"] fieldset { grid-template-columns: 1fr !important; }
  #lab-form { grid-template-columns: 1fr !important; }
}

@media (max-width: 460px) {
  body { font-size: 14.5px; }
  h1 { font-size: 1.35rem; }
  .headline h1 { font-size: 1.4rem; }
  .metric .value { font-size: 1.6rem; }
  .incident .actions { flex-direction: column; align-items: stretch; }
  .incident .actions button, .incident .actions .button { justify-content: center; }
}

/* Motion only ever communicates a real state change, and never at all here. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
}
@media (prefers-reduced-motion: no-preference) {
  .state-changed { animation: nyst-settle 420ms ease-out; }
  @keyframes nyst-settle { from { background: var(--uncertain-bg); } to { background: transparent; } }
}

/* ============================================================ dialog */
dialog {
  border: 1px solid var(--rule); border-radius: var(--radius-lg); padding: 0;
  box-shadow: var(--shadow-raised); max-width: min(560px, calc(100vw - 32px)); width: 100%;
  max-height: calc(100vh - 32px); overflow: auto; color: var(--ink); background: var(--surface);
}
dialog::backdrop { background: rgba(16, 23, 40, .42); }
dialog .dialog-head { padding: 18px 22px 0; }
dialog .dialog-body { padding: 14px 22px; }
dialog .dialog-foot { padding: 14px 22px 20px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
`;
