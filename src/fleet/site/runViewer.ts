/**
 * The run viewer (docs/fleet-composition-layer.md §6).
 *
 * Built before any authoring UI on purpose: the first thing anyone actually
 * needs from a long-running workflow is "it has been going 40 minutes — where
 * is it stuck, and why", not "how do I draw this". So the page leads with how
 * long the current state has been current, and the timeline shows the gap
 * between steps rather than only their timestamps.
 *
 * Served as one self-contained page with no build step and no dependencies.
 * It talks to the same JSON API an agent would, using an agent token the
 * viewer keeps in localStorage, so it needs no session machinery of its own.
 */
export const RUN_VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet runs</title>
<style>
:root {
  --ground: #F6F7F8;
  --surface: #FFFFFF;
  --surface-2: #EDEFF2;
  --ink: #171A1D;
  --muted: #626B75;
  --rule: #DDE1E6;
  --accent: #1F5F8B;
  --ok: #1B6E4A;
  --ok-soft: #E2F0E9;
  --warn: #8A5A16;
  --warn-soft: #F7EDDD;
  --bad: #9E2F23;
  --bad-soft: #F8E6E3;
  --live: #1F5F8B;
  --live-soft: #E3EDF4;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #111315;
    --surface: #191C1F;
    --surface-2: #22262A;
    --ink: #E4E8EC;
    --muted: #98A2AD;
    --rule: #2C3136;
    --accent: #6FB3E0;
    --ok: #63C79A;
    --ok-soft: #163025;
    --warn: #D9AE66;
    --warn-soft: #322713;
    --bad: #E8887C;
    --bad-soft: #35201D;
    --live: #6FB3E0;
    --live-soft: #162834;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}
header {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--rule);
  background: var(--surface);
}
h1 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -.01em;
}
header .spacer { flex: 1; }
input {
  font: inherit;
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 5px 9px;
  border: 1px solid var(--rule);
  border-radius: 4px;
  background: var(--ground);
  color: var(--ink);
  min-width: 8rem;
}
button {
  font: inherit;
  font-size: 12.5px;
  padding: 5px 12px;
  border: 1px solid var(--rule);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink);
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
.hint { color: var(--muted); font-size: 12.5px; }

main {
  display: grid;
  grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
  gap: 0;
  min-height: calc(100vh - 53px);
}
@media (max-width: 820px) { main { grid-template-columns: 1fr; } }

#runs { border-right: 1px solid var(--rule); overflow-y: auto; }
.run {
  display: grid;
  gap: 5px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
  cursor: pointer;
  background: none;
  border-left: 3px solid transparent;
  width: 100%;
  text-align: left;
  border-radius: 0;
}
.run:hover { background: var(--surface); }
.run[aria-current="true"] { background: var(--surface); border-left-color: var(--accent); }
.run-top { display: flex; align-items: center; gap: 8px; }
.run-id { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.run-ref { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pill {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.pill.live { background: var(--live-soft); color: var(--live); }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.idle { background: var(--surface-2); color: var(--muted); }

/* How long the current state has been current — the thing you actually
   came here to find out. */
.elapsed { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.elapsed.stale { color: var(--warn); font-weight: 600; }

#detail { padding: 20px 24px; overflow-y: auto; }
#detail h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
.sub { color: var(--muted); font-size: 12.5px; margin-bottom: 18px; font-family: var(--mono); }
.banner {
  border-left: 3px solid var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
  padding: 10px 14px;
  border-radius: 0 4px 4px 0;
  margin-bottom: 18px;
  font-size: 13px;
}
.banner.warn { border-left-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--muted);
  margin: 22px 0 10px;
  font-weight: 600;
}
.timeline { display: grid; gap: 0; }
.tl {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 7px 0;
}
.dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--rule);
  margin: 5px auto 0;
  position: relative;
}
.tl:not(:last-child) .dot::after {
  content: "";
  position: absolute;
  left: 50%; top: 11px;
  width: 1px; height: calc(100% + 14px);
  background: var(--rule);
  transform: translateX(-50%);
}
.tl.current .dot { background: var(--live); box-shadow: 0 0 0 3px var(--live-soft); }
.tl-name { font-family: var(--mono); font-size: 12.5px; }
.tl-meta { color: var(--muted); font-size: 12px; }
.tl-at { color: var(--muted); font-size: 12px; font-family: var(--mono); white-space: nowrap; }
/* The gap between two steps is the interesting number, not the wall clock. */
.gap { font-family: var(--mono); font-size: 11px; color: var(--muted); padding-left: 30px; }
.gap.slow { color: var(--warn); }

pre {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
  margin: 0;
}
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Fleet runs</h1>
  <input id="tenant" placeholder="tenant" size="10">
  <input id="token" type="password" placeholder="agent token" size="20">
  <button id="reload">Reload</button>
  <span class="spacer"></span>
  <span class="hint" id="status"></span>
</header>

<main>
  <div id="runs"><p class="empty">Enter a tenant and token.</p></div>
  <div id="detail"><p class="empty">Pick a run.</p></div>
</main>

<script>
const $ = (id) => document.getElementById(id);
const tenantEl = $("tenant"), tokenEl = $("token");
let selected = null, timer = null;

tenantEl.value = localStorage.getItem("fleet.tenant") || "";
tokenEl.value = localStorage.getItem("fleet.token") || "";

const LIVE = ["queued", "developing", "pr_opened", "reviewing", "revising",
              "changes_requested", "merge_requested", "approved"];

function pillClass(state, status) {
  if (state === "completed") return "ok";
  if (state === "failed" || state === "cancelled") return "bad";
  if (state === "needs_human") return "warn";
  return LIVE.includes(status) || LIVE.includes(state) ? "live" : "idle";
}

function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return (s / 3600).toFixed(1) + "h";
  return Math.round(s / 86400) + "d";
}

function gapBetween(a, b) {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return { text: s + "s", slow: false };
  if (s < 3600) return { text: Math.round(s / 60) + "m", slow: s > 600 };
  return { text: (s / 3600).toFixed(1) + "h", slow: true };
}

function isTerminal(state) {
  return ["completed", "failed", "cancelled", "needs_human"].includes(state);
}

async function api(path) {
  const res = await fetch(path, {
    headers: { authorization: "Bearer " + tokenEl.value },
  });
  if (!res.ok) throw new Error(res.status === 401 ? "unauthorized" : "HTTP " + res.status);
  return res.json();
}

function base() {
  return "/a2a/t/" + encodeURIComponent(tenantEl.value) + "/workflows";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderRuns(runs) {
  const box = $("runs");
  box.replaceChildren();
  if (!runs.length) {
    box.append(el("p", "empty", "No runs yet."));
    return;
  }
  for (const run of runs) {
    const btn = el("button", "run");
    btn.setAttribute("aria-current", String(run.id === selected));

    const top = el("div", "run-top");
    top.append(el("span", "run-id", "#" + run.id));
    const pill = el("span", "pill " + pillClass(run.state, run.status), run.status);
    top.append(pill);
    const spacer = el("span"); spacer.style.flex = "1";
    top.append(spacer);

    // For a live run this is the headline number: how long it has sat here.
    const elapsed = el("span", "elapsed", ago(run.updatedAt));
    if (!isTerminal(run.state) && Date.now() - Date.parse(run.updatedAt) > 15 * 60000) {
      elapsed.classList.add("stale");
    }
    top.append(elapsed);
    btn.append(top);
    btn.append(el("div", "run-ref", run.sourceRef || ""));
    if (run.reason) btn.append(el("div", "run-ref", run.reason));

    btn.addEventListener("click", () => { selected = run.id; refresh(); });
    box.append(btn);
  }
}

async function renderDetail(run) {
  const box = $("detail");
  box.replaceChildren();
  box.append(el("h2", null, "Run #" + run.id + " · " + run.status));
  box.append(el("div", "sub", run.sourceType + " / " + (run.sourceRef || "—")));

  if (run.reason) {
    const b = el("div", "banner" + (run.state === "needs_human" ? " warn" : ""),
      (run.state === "needs_human" ? "Needs a human: " : "Failed: ") + run.reason);
    box.append(b);
  } else if (!isTerminal(run.state)) {
    const waited = ago(run.updatedAt);
    box.append(el("div", "banner warn",
      "Waiting in " + run.state + " for " + waited + "."));
  }

  const { events } = await api(base() + "/runs/" + run.id + "/events");
  box.append(el("h3", null, "Timeline"));
  const tl = el("div", "timeline");
  events.forEach((ev, i) => {
    const prev = events[i - 1];
    if (prev) {
      const gap = gapBetween(prev.createdAt, ev.createdAt);
      if (gap) {
        const g = el("div", "gap" + (gap.slow ? " slow" : ""), "＋" + gap.text);
        tl.append(g);
      }
    }
    const row = el("div", "tl" + (i === events.length - 1 ? " current" : ""));
    row.append(el("div", "dot"));
    const mid = el("div");
    mid.append(el("div", "tl-name", ev.eventType));
    const payload = ev.payload && Object.keys(ev.payload).length
      ? JSON.stringify(ev.payload)
      : "";
    if (payload) mid.append(el("div", "tl-meta", payload));
    row.append(mid);
    row.append(el("div", "tl-at", ago(ev.createdAt) + " ago"));
    tl.append(row);
  });
  box.append(tl);

  box.append(el("h3", null, "Variables"));
  box.append(el("pre", null, JSON.stringify(run.vars, null, 2)));
}

async function refresh() {
  if (!tenantEl.value || !tokenEl.value) return;
  localStorage.setItem("fleet.tenant", tenantEl.value);
  localStorage.setItem("fleet.token", tokenEl.value);
  try {
    const { runs } = await api(base() + "/runs");
    renderRuns(runs);
    const current = runs.find((r) => r.id === selected) || runs[0];
    if (current) {
      selected = current.id;
      renderRuns(runs);
      await renderDetail(current);
    }
    $("status").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (err) {
    $("status").textContent = String(err.message || err);
  }
}

$("reload").addEventListener("click", refresh);
for (const input of [tenantEl, tokenEl]) {
  input.addEventListener("change", () => { selected = null; refresh(); });
}
// A run that is stuck is the case this page exists for, so it keeps itself
// current rather than making you press reload to find out.
timer = setInterval(refresh, 5000);
refresh();
</script>
</body>
</html>`;
