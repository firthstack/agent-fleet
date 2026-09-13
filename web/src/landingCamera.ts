/**
 * Where the camera is, given how far down the page you are.
 *
 * Pulled out of the component because this mapping is the whole feature: it
 * decides which stop's overlay is lit, and getting the boundaries wrong shows
 * the globe during the hero or the fleet during compose — which reads as a
 * bug, not a design choice, and is invisible until someone scrolls.
 */

/** The hero owns the top of the page on its own; the stops split the rest. */
export const HERO_BAND = 0.12;

/** 0 = the hero, 1…stops = each stop in order. */
export function stageFor(progress: number, stops: number): number {
  const p = Math.min(1, Math.max(0, progress));
  if (p < HERO_BAND) return 0;
  const into = (p - HERO_BAND) / (1 - HERO_BAND);
  return Math.min(stops, Math.floor(into * stops) + 1);
}

/** Scroll position as a 0…1 fraction of the scrollable distance. */
export function progressOf(scrollY: number, scrollHeight: number, viewport: number): number {
  const max = scrollHeight - viewport;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / max));
}
