/**
 * Where the camera is, given how far down the page you are.
 *
 * The path is written as keyframes rather than CSS `calc()` because it is not
 * monotonic: the globe rises from below the fold, crosses to the right half
 * so the copy on the left never sits on top of it, then falls away to the
 * left as the view pulls back. Expressing that in interpolated custom
 * properties was unreadable and untestable; here it is both.
 */

/** The hero owns the top of the page on its own; the stops split the rest. */
export const HERO_BAND = 0.1;

/** 0 = the hero, 1…stops = each stop in order. */
export function stageFor(progress: number, stops: number): number {
  const p = clamp01(progress);
  if (p < HERO_BAND) return 0;
  const into = (p - HERO_BAND) / (1 - HERO_BAND);
  return Math.min(stops, Math.floor(into * stops) + 1);
}

/** Scroll position as a 0…1 fraction of the scrollable distance. */
export function progressOf(scrollY: number, scrollHeight: number, viewport: number): number {
  const max = scrollHeight - viewport;
  if (max <= 0) return 0;
  return clamp01(scrollY / max);
}

export interface Camera {
  /** Centre of the globe, as a percentage of the viewport width. */
  x: number;
  /** Top of the globe, as a percentage of the viewport height. Above 100 it
   *  is below the fold, which is how the hero shows only a rim. */
  y: number;
  /** Diameter, in viewport-height units, so the globe scales with the frame. */
  size: number;
}

/**
 * The camera path. Each entry is `[progress, x%, yTop%, sizeVh]`.
 *
 * `y` is the globe's TOP edge, not its centre: the hero's horizon is the one
 * measurement that has to be exact — it belongs under the headline, and
 * anchoring by centre made it drift with every change of size.
 */
const PATH: Array<[number, number, number, number]> = [
  // hero — a rim below the copy, nothing more
  [0.0, 50, 78, 210],
  // connect — the whole globe swings into the right half. Deliberately not
  // filling it: the planet is scenery, and at 68vh it was the loudest thing
  // on a page whose subject is the five markers standing on it.
  [0.26, 76, 30, 54],
  // compose — held there while the run walks it
  [0.5, 76, 30, 54],
  // trace — falling away to the left, the right half freed for the timeline
  [0.76, 26, 62, 26],
  // fleet — far out, low and left
  [1.0, 12, 74, 15],
];

export function cameraAt(progress: number): Camera {
  const p = clamp01(progress);
  let i = 0;
  while (i < PATH.length - 2 && p > PATH[i + 1][0]) i += 1;
  const [p0, x0, y0, s0] = PATH[i];
  const [p1, x1, y1, s1] = PATH[i + 1];
  const span = p1 - p0;
  // `ease` keeps the globe from snapping between keyframes; the path is read
  // as one move, so the joins have to be invisible.
  const t = span <= 0 ? 0 : ease(clamp01((p - p0) / span));
  return {
    x: lerp(x0, x1, t),
    y: lerp(y0, y1, t),
    size: lerp(s0, s1, t),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
