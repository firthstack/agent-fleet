// No `.ts` on the import, unlike the rest of web/src: this module is pulled
// into the root tsc run through its test, and that config emits, so it cannot
// turn on `allowImportingTsExtensions`.
import { gapBetween, isTerminal } from "./runFormat";

/**
 * A run's history, as something you can read down a rail.
 *
 * The events the driver writes are a flat list of names — `created`, then one
 * per state walked, then maybe `failed` — with the interesting part buried in
 * a JSON payload. Rendering that payload verbatim put a scrolling code block
 * under every row and left the one thing anybody opens this page for (which
 * step broke, and why) indistinguishable from the rest.
 *
 * So the payload is read here instead: each event becomes a line of plain
 * English, a tone, and whatever the line did not account for. Newest first,
 * because a run you are watching is a run whose last event you want.
 */

export type StepTone = "ok" | "bad" | "warn" | "wait" | "step" | "start";

export interface TimelineStep {
  /** The event's own name: a state the run entered, or a lifecycle event. */
  label: string;
  tone: StepTone;
  /** One line drawn from the payload, or null when there was nothing in it. */
  note: string | null;
  /** An error code, kept apart from the sentence so it can be shown as one. */
  code: string | null;
  /** Elapsed since the step below this one — the rail segment's label. */
  gap: { text: string; slow: boolean } | null;
  at: string;
  /** What the note did not account for. Shown folded away, not by default. */
  rest: Record<string, unknown> | null;
}

/** Lifecycle events, as opposed to the names of states in the definition. */
const LIFECYCLE = new Set(["created", "queued", "deduplicated", "failed"]);

export function toneOf(label: string): StepTone {
  if (label === "failed" || label === "cancelled") return "bad";
  if (label === "completed") return "ok";
  if (label === "needs_human") return "warn";
  if (label === "queued" || label === "deduplicated") return "wait";
  if (label === "created") return "start";
  return "step";
}

/** One character per tone. The page is already monospace; a shape reads
 *  faster than a colour, and survives being printed or colour-blind. */
export function glyphOf(tone: StepTone): string {
  if (tone === "bad") return "✕";
  if (tone === "ok") return "✓";
  if (tone === "warn") return "!";
  if (tone === "wait") return "○";
  if (tone === "start") return "◇";
  return "●";
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload != null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * The payload, as a sentence and a remainder.
 *
 * Every key the sentence uses is dropped from the remainder, so nothing is
 * said twice and nothing is silently lost: a payload shape this does not know
 * about still arrives on screen, just folded away.
 */
function readPayload(
  label: string,
  payload: unknown,
): { note: string | null; code: string | null; rest: Record<string, unknown> | null } {
  const p = asRecord(payload);
  const used: string[] = [];
  const take = (key: string) => {
    used.push(key);
    return p[key];
  };
  let note: string | null = null;
  let code: string | null = null;

  if (label === "failed") {
    code = str(take("error"));
    const reason = str(take("reason"));
    const state = str(take("state"));
    const skillId = str(take("skillId"));
    // The state it died in leads: on a run that walked several states in one
    // decision, "which one" is the question, and `failed` is not an answer.
    const where = state ? `in ${state}` : null;
    const what = skillId ? `calling ${skillId}` : null;
    note = [reason, [where, what].filter(Boolean).join(", ")].filter(Boolean).join(" — ") || null;
  } else if (label === "created") {
    const workflow = str(take("workflow"));
    note = workflow ? `from ${workflow}` : null;
    take("vars"); // the run's own Variables panel already shows these
  } else if (label === "queued") {
    const reason = str(take("reason"));
    const limit = take("limit");
    note =
      reason === "tenant_at_capacity"
        ? `waiting for a slot — this tenant runs ${limit ?? "a limited number"} at a time`
        : reason;
  } else if (label === "deduplicated") {
    const type = str(take("sourceType"));
    const ref = str(take("sourceRef"));
    note = ref ? `already running for ${type ? `${type} ` : ""}${ref}` : null;
  } else {
    const skillId = str(take("skillId"));
    const taskId = take("taskId");
    const reason = str(take("reason"));
    if (skillId && taskId != null) note = `dispatched ${skillId} · task #${taskId}`;
    else if (skillId) note = `${skillId} — never dispatched`;
    else if (reason) note = reason;
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (used.includes(k)) continue;
    if (v == null) continue;
    rest[k] = v;
  }
  return { note, code, rest: Object.keys(rest).length > 0 ? rest : null };
}

/**
 * The events, newest first, each carrying the gap to the one below it.
 *
 * `events` arrives oldest-first, which is the order the gaps have to be
 * measured in; the reverse happens once, at the end.
 */
export function buildTimeline(
  events: Array<{ eventType: string; payload: unknown; createdAt: string }>,
): TimelineStep[] {
  const steps = events.map((event, i) => {
    const { note, code, rest } = readPayload(event.eventType, event.payload);
    return {
      label: event.eventType,
      tone: toneOf(event.eventType),
      note,
      code,
      // The gap belongs to the segment below the node, so it is the time
      // since the PREVIOUS event — which is what the rail draws through.
      gap: i > 0 ? gapBetween(events[i - 1].createdAt, event.createdAt) : null,
      at: event.createdAt,
      rest,
    };
  });
  return steps.reverse();
}

/**
 * The one-line verdict above the rail.
 *
 * A run that is still going says where it is; one that has stopped says how
 * it stopped, and a failure says why without anyone having to scan for it.
 */
export function verdictOf(
  run: { state: string; reason: string | null },
  steps: TimelineStep[],
): { tone: StepTone; text: string } {
  const tone = toneOf(run.state);
  if (!isTerminal(run.state)) {
    return { tone, text: `running · ${run.state}` };
  }
  // `run.reason` is the driver's own word for it. When the run failed while
  // dispatching, the `failed` event has the fuller story.
  const failure = steps.find((s) => s.tone === "bad");
  const why = run.reason ?? failure?.note ?? null;
  return { tone, text: why ? `${run.state} — ${why}` : run.state };
}
