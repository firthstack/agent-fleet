import { describe, expect, it } from "vitest";
import { buildTimeline, glyphOf, toneOf, verdictOf } from "../../web/src/runTimeline";

/**
 * The shape run #16 actually had: created, two states walked, then a dispatch
 * that found no agent. The page existed to answer "why did this stop" and
 * answered it with four JSON blocks and a clipped word.
 */
const RUN_16 = [
  {
    eventType: "created",
    payload: { workflow: "develop-review-merge", vars: { repo: "acme/web" } },
    createdAt: "2026-09-13T10:00:00.000Z",
  },
  {
    eventType: "developing",
    payload: { skillId: "dev.implement", taskId: 41 },
    createdAt: "2026-09-13T10:00:02.000Z",
  },
  {
    eventType: "requesting_merge",
    payload: { skillId: "merge.request" },
    createdAt: "2026-09-13T14:06:02.000Z",
  },
  {
    eventType: "failed",
    payload: {
      error: "no_agent",
      reason: "no agent advertises merge.request",
      state: "requesting_merge",
      skillId: "merge.request",
    },
    createdAt: "2026-09-13T14:06:02.000Z",
  },
];

describe("a run's timeline", () => {
  const steps = buildTimeline(RUN_16);

  it("puts the newest step first", () => {
    expect(steps.map((s) => s.label)).toEqual([
      "failed",
      "requesting_merge",
      "developing",
      "created",
    ]);
  });

  it("ends on where the run began", () => {
    // The last row is the one the rail stops at, so it has to be `created`
    // and not whatever happened to sort last.
    expect(steps[steps.length - 1].label).toBe("created");
    expect(steps[steps.length - 1].tone).toBe("start");
  });

  it("marks exactly one step as the failure", () => {
    expect(steps.filter((s) => s.tone === "bad")).toHaveLength(1);
    expect(steps[0].tone).toBe("bad");
  });

  it("says why it failed, and where, without opening anything", () => {
    expect(steps[0].note).toContain("no agent advertises merge.request");
    expect(steps[0].note).toContain("requesting_merge");
    expect(steps[0].code).toBe("no_agent");
  });

  it("keeps the gap on the segment below each node", () => {
    // 10:00:02 → 14:06:02 is the four hours the run spent developing, and it
    // belongs between those two steps, not on either end of the list.
    const developing = steps.find((s) => s.label === "requesting_merge");
    expect(developing?.gap?.text).toBe("4.1h");
    expect(developing?.gap?.slow).toBe(true);
    // Nothing came before `created`, so it measures nothing.
    expect(steps[steps.length - 1].gap).toBeNull();
  });

  it("turns a dispatch into a sentence and keeps nothing back", () => {
    const developing = steps.find((s) => s.label === "developing");
    expect(developing?.note).toBe("dispatched dev.implement · task #41");
    // Everything in the payload went into the sentence, so there is no
    // leftover block to fold away.
    expect(developing?.rest).toBeNull();
  });

  it("folds away a payload it does not recognise rather than dropping it", () => {
    const [odd] = buildTimeline([
      {
        eventType: "developing",
        payload: { skillId: "dev.implement", taskId: 41, attempt: 3 },
        createdAt: "2026-09-13T10:00:02.000Z",
      },
    ]);
    expect(odd.note).toBe("dispatched dev.implement · task #41");
    expect(odd.rest).toEqual({ attempt: 3 });
  });

  it("says a queued run is waiting for a slot, and for how many", () => {
    const [queued] = buildTimeline([
      {
        eventType: "queued",
        payload: { reason: "tenant_at_capacity", limit: 5 },
        createdAt: "2026-09-13T10:00:00.000Z",
      },
    ]);
    expect(queued.tone).toBe("wait");
    expect(queued.note).toContain("5");
    expect(queued.note).toContain("waiting for a slot");
  });

  it("survives an event with no payload at all", () => {
    // Pass-through states are written with `{}`, and a payload could be null.
    for (const payload of [{}, null, undefined, "not an object"]) {
      const [step] = buildTimeline([
        { eventType: "pr_opened", payload, createdAt: "2026-09-13T10:00:00.000Z" },
      ]);
      expect(step.note).toBeNull();
      expect(step.rest).toBeNull();
      expect(step.tone).toBe("step");
    }
  });
});

describe("the verdict above the rail", () => {
  it("leads with the reason a failed run failed", () => {
    const v = verdictOf({ state: "failed", reason: null }, buildTimeline(RUN_16));
    expect(v.tone).toBe("bad");
    expect(v.text).toContain("no agent advertises merge.request");
  });

  it("prefers the run's own reason when it has one", () => {
    const v = verdictOf(
      { state: "failed", reason: "cancelled by the operator" },
      buildTimeline(RUN_16),
    );
    expect(v.text).toContain("cancelled by the operator");
  });

  it("says where an unfinished run is sitting", () => {
    const v = verdictOf({ state: "reviewing", reason: null }, []);
    expect(v.text).toBe("running · reviewing");
    expect(v.tone).toBe("step");
  });
});

describe("the rail's marks", () => {
  it("gives the failure a shape of its own, not just a colour", () => {
    // Colour alone fails for a colour-blind reader and in print.
    const marks = (["ok", "bad", "warn", "wait", "step", "start"] as const).map(glyphOf);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it("reads a terminal state as terminal", () => {
    expect(toneOf("completed")).toBe("ok");
    expect(toneOf("failed")).toBe("bad");
    expect(toneOf("cancelled")).toBe("bad");
    expect(toneOf("needs_human")).toBe("warn");
  });
});
