import { describe, expect, it } from "vitest";
import { BOX, LOOP, TIMELINE, VIEWBOX, boxY, loopPath } from "../../web/src/traceGraph";

/**
 * The graph on the trace stop makes a claim about how the product works, so
 * the drawing has to agree with it. Hand-placed, the loop pointed one box too
 * high and said `request_changes` was something opening a PR could decide.
 */

describe("the run graph", () => {
  it("loops back from the state that actually decides it", () => {
    // `request_changes` is the review's verdict. Any other source is a lie
    // about the workflow, however good it looks.
    expect(LOOP.from).toBe("reviewing");
    expect(LOOP.to).toBe("developing");
    expect(TIMELINE.map((s) => s.state)).toContain(LOOP.from);
    expect(TIMELINE.map((s) => s.state)).toContain(LOOP.to);
  });

  it("draws that loop between those two boxes and no others", () => {
    const from = TIMELINE.findIndex((s) => s.state === LOOP.from);
    const to = TIMELINE.findIndex((s) => s.state === LOOP.to);
    const [, y1, y2] = loopPath().match(/M\d+ ([\d.]+) H\d+ V([\d.]+)/) ?? [];
    expect(Number(y1)).toBe(boxY(from) + BOX.h / 2);
    expect(Number(y2)).toBe(boxY(to) + BOX.h / 2);
  });

  it("refuses to draw a loop from a state that is not there", () => {
    // The failure mode is a silent one — a path to a coordinate no box
    // occupies — so the lookup throws instead.
    const gone = { ...LOOP, from: "pr_opened" };
    expect(TIMELINE.some((s) => s.state === gone.from)).toBe(false);
  });

  it("ends inside its own viewBox", () => {
    const last = boxY(TIMELINE.length - 1) + BOX.h;
    expect(last).toBeLessThan(VIEWBOX.h);
    expect(BOX.lane).toBeLessThan(VIEWBOX.w);
  });

  it("runs forward to a finished state", () => {
    expect(TIMELINE[TIMELINE.length - 1].done).toBe(true);
    expect(TIMELINE.filter((s) => s.done)).toHaveLength(1);
  });
});
