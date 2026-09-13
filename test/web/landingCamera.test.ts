import { describe, expect, it } from "vitest";
import { cameraAt, HERO_BAND, progressOf, stageFor } from "../../web/src/landingCamera";

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

describe("cameraAt", () => {
  it("keeps the globe below the fold in the hero, so only a rim shows", () => {
    // Its top edge starts past the bottom of the frame; anything less and the
    // horizon crosses the headline, which is what it did before.
    expect(cameraAt(0).y).toBeGreaterThan(70);
  });

  it("crosses to the right half while the copy is on the left", () => {
    // Stops 1 and 2 put text down the left, so the globe has to be clear of it.
    expect(cameraAt(0.26).x).toBeGreaterThan(60);
    expect(cameraAt(0.5).x).toBeGreaterThan(60);
  });

  it("ends up small and to the left, freeing the right for the fleet", () => {
    const end = cameraAt(1);
    expect(end.x).toBeLessThan(30);
    expect(end.size).toBeLessThan(cameraAt(0.26).size);
  });

  it("shrinks the whole way once the globe has resolved", () => {
    let last = cameraAt(0.26).size;
    for (let p = 0.3; p <= 1.0001; p += 0.05) {
      const size = cameraAt(p).size;
      expect(size).toBeLessThanOrEqual(last + 0.001);
      last = size;
    }
  });

  it("moves without jumps between keyframes", () => {
    // A visible snap would read as a glitch rather than a camera.
    let prev = cameraAt(0);
    for (let p = 0.01; p <= 1.0001; p += 0.01) {
      const now = cameraAt(p);
      expect(Math.abs(now.x - prev.x)).toBeLessThan(6);
      expect(Math.abs(now.y - prev.y)).toBeLessThan(6);
      prev = now;
    }
  });

  it("survives a scroller reporting nonsense", () => {
    // NaN in a width would drop the globe from the page entirely.
    for (const p of [Number.NaN, Infinity, -Infinity, -2, 5]) {
      const c = cameraAt(p);
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
      expect(Number.isFinite(c.size)).toBe(true);
    }
  });
});
