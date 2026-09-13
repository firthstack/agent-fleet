import { describe, expect, it } from "vitest";
import { HERO_BAND, progressOf, stageFor } from "../../web/src/landingCamera";

/**
 * The landing page's camera. Getting a boundary wrong shows the globe during
 * the hero or the fleet during compose — which reads as a bug rather than a
 * design choice, and is invisible until somebody scrolls.
 */

describe("stageFor", () => {
  it("holds the hero until the page has actually moved", () => {
    expect(stageFor(0, 4)).toBe(0);
    expect(stageFor(HERO_BAND - 0.001, 4)).toBe(0);
  });

  it("enters the first stop as soon as the hero band is past", () => {
    expect(stageFor(HERO_BAND, 4)).toBe(1);
  });

  it("ends on the last stop, never past it", () => {
    expect(stageFor(1, 4)).toBe(4);
    // Rounding at the very end must not index a stop that does not exist.
    expect(stageFor(0.9999, 4)).toBe(4);
  });

  it("walks the stops in order, one at a time", () => {
    const seen = [];
    for (let p = 0; p <= 1.0001; p += 0.01) seen.push(stageFor(p, 4));
    // Monotonic: the camera never jumps backwards mid-scroll.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(new Set(seen)).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it("clamps input rather than trusting the scroller", () => {
    // Rubber-band scrolling on macOS and iOS reports positions outside the
    // range; an unclamped value would index past the last stop.
    expect(stageFor(-0.5, 4)).toBe(0);
    expect(stageFor(1.5, 4)).toBe(4);
  });
});

describe("progressOf", () => {
  it("is zero when there is nothing to scroll", () => {
    // A short viewport-height page: dividing by zero would be NaN, and NaN
    // in a CSS custom property silently drops the whole transform.
    expect(progressOf(0, 800, 800)).toBe(0);
    expect(progressOf(0, 600, 800)).toBe(0);
  });

  it("runs 0 to 1 across the scrollable distance", () => {
    expect(progressOf(0, 2400, 800)).toBe(0);
    expect(progressOf(800, 2400, 800)).toBe(0.5);
    expect(progressOf(1600, 2400, 800)).toBe(1);
  });

  it("clamps an overscrolled position", () => {
    expect(progressOf(-40, 2400, 800)).toBe(0);
    expect(progressOf(9999, 2400, 800)).toBe(1);
  });
});
