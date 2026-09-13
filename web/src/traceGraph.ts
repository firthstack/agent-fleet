/**
 * The run graph on the trace stop.
 *
 * The loop's endpoints are derived from state names rather than written as
 * coordinates. Hand-placed, it pointed at the box above the one it meant and
 * said `request_changes` was something opening a PR could decide — a claim
 * about how the product works, made by a typo in a path.
 */

export interface TraceStep {
  state: string;
  /** Elapsed before the next state. */
  gap: string;
  /** Worth calling out — the hours, not the seconds. */
  slow: boolean;
  done: boolean;
}

/**
 * The real definition has a `pr_opened` milestone between developing and
 * reviewing. It is left out here: the one edge this picture exists to show is
 * the loop, and four boxes carry it in two thirds the height of six.
 */
export const TIMELINE: TraceStep[] = [
  { state: "developing", gap: "4.1h", slow: true, done: false },
  { state: "reviewing", gap: "3.2h", slow: true, done: false },
  { state: "requesting_merge", gap: "11s", slow: false, done: false },
  { state: "completed", gap: "", slow: false, done: true },
];

/** `request_changes` is the review's verdict, so that is where it leaves. */
export const LOOP = {
  from: "reviewing",
  to: "developing",
  label: "request_changes",
} as const;

export const BOX = { x: 40, w: 220, h: 34, top: 26, pitch: 84, lane: 336 } as const;

export const VIEWBOX = {
  w: 460,
  h: BOX.top + (TIMELINE.length - 1) * BOX.pitch + BOX.h + 36,
} as const;

export function boxY(index: number): number {
  return BOX.top + index * BOX.pitch;
}

function midOf(state: string): number {
  const i = TIMELINE.findIndex((s) => s.state === state);
  if (i < 0) throw new Error(`no state named ${state} in the trace graph`);
  return boxY(i) + BOX.h / 2;
}

/** Out of the right edge of `from`, up its own lane, back into `to`. */
export function loopPath(): string {
  return `M${BOX.x + BOX.w} ${midOf(LOOP.from)} H${BOX.lane} V${midOf(LOOP.to)} H${BOX.x + BOX.w}`;
}

export function loopLabelY(): number {
  return (midOf(LOOP.from) + midOf(LOOP.to)) / 2 + 4;
}
