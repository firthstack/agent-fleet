/**
 * How a run reads on a page. Carried over from the standalone viewer, which
 * `/app/runs` replaces: the numbers it showed were the useful part, only the
 * "paste an agent token" framing around them was not (docs §4).
 */

export const TERMINAL_STATES = ["completed", "failed", "cancelled", "needs_human"];

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Accepted, but holding no concurrency slot yet — nothing has been dispatched
 * and no agent knows about it. Distinct from `queued` alone, which a run also
 * passes through in the instant before its opening step goes out.
 */
export function isWaitingForSlot(run: { state: string; admittedAt: string | null }): boolean {
  return run.admittedAt === null && !isTerminal(run.state);
}

/** `ok` / `bad` / `warn` / `live`, reused for both the run row and its state. */
export function runTone(state: string): string {
  if (state === "completed") return "ok";
  if (state === "failed" || state === "cancelled") return "bad";
  if (state === "needs_human") return "warn";
  return "live";
}

/** How long ago, at the coarsest unit that still says something. */
export function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * The gap between two timeline entries, and whether it is worth noticing.
 *
 * The gap is the point of the timeline: a run that took six hours spent them
 * somewhere, and the whole reason to render steps in order is to show where.
 */
export function gapBetween(a: string, b: string): { text: string; slow: boolean } | null {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return { text: `${s}s`, slow: false };
  if (s < 3600) return { text: `${Math.round(s / 60)}m`, slow: s > 600 };
  return { text: `${(s / 3600).toFixed(1)}h`, slow: true };
}

/**
 * The agent card's "last run" line: how long ago it finished, headlined with
 * how long it took — the detail (exact start/end) goes in `title`, a tooltip,
 * so the card itself stays scannable.
 */
export function lastRunSummary(
  startedAt: string | null,
  endedAt: string | null,
): { text: string; title: string } | null {
  if (!endedAt) return null;
  const gap = startedAt ? gapBetween(startedAt, endedAt) : null;
  // gapBetween drops sub-second gaps as noise for the run timeline, but a
  // fast completed run still took *some* time and should say so here.
  const ms = startedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
  const took = gap?.text ?? (ms >= 0 && ms < 1000 ? "<1s" : null);
  const text = `last run ${ago(endedAt)} ago${took ? ` · took ${took}` : ""}`;
  const title = startedAt
    ? `${new Date(startedAt).toLocaleString()} \u2192 ${new Date(endedAt).toLocaleString()}`
    : new Date(endedAt).toLocaleString();
  return { text, title };
}
