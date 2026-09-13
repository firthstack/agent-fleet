import { afterEach, describe, expect, it, vi } from "vitest";
import { lastRunSummary } from "../../web/src/runFormat";

/**
 * The agent-list card's "last run" line (issue #9): when the most recently
 * completed run ended, and — via the tooltip — exactly when it started and
 * ended, so a developer can see both the headline and the detail.
 */
describe("lastRunSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is absent when nothing has completed yet", () => {
    expect(lastRunSummary(null, null)).toBeNull();
  });

  it("reports how long ago the run ended and how long it took", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-12T00:10:00.000Z"));
    const startedAt = "2026-09-12T00:00:00.000Z";
    const endedAt = "2026-09-12T00:05:00.000Z";

    const summary = lastRunSummary(startedAt, endedAt);

    expect(summary?.text).toBe("last run 5m ago · took 5m");
    expect(summary?.title).toBe(
      `${new Date(startedAt).toLocaleString()} \u2192 ${new Date(endedAt).toLocaleString()}`,
    );
  });

  it("still reports the end time when the start time is unknown", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-12T00:10:00.000Z"));
    const endedAt = "2026-09-12T00:05:00.000Z";

    const summary = lastRunSummary(null, endedAt);

    expect(summary?.text).toBe("last run 5m ago");
    expect(summary?.title).toBe(new Date(endedAt).toLocaleString());
  });
});
