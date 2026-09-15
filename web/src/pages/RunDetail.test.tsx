// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../api.ts", () => ({
  getMe: vi.fn().mockResolvedValue({
    user: { email: "dev@example.com" },
    tenant: { slug: "acme" },
  }),
  getRun: vi.fn().mockResolvedValue({
    run: {
      id: 41,
      workflowId: 3,
      state: "reviewing",
      status: "active",
      reason: null,
      vars: { repository: "fleet" },
      sourceType: "webhook",
      sourceRef: "issue-41",
      awaitingTaskId: 7,
      admittedAt: "2026-09-14T18:00:00.000Z",
      updatedAt: "2026-09-14T18:01:00.000Z",
    },
  }),
  getRunEvents: vi.fn().mockResolvedValue({
    events: [
      {
        eventType: "created",
        payload: { workflow: "ship-change", vars: { repository: "fleet" } },
        createdAt: "2026-09-14T18:00:00.000Z",
      },
      {
        eventType: "reviewing",
        payload: { skillId: "review-code", taskId: 5 },
        createdAt: "2026-09-14T18:00:15.000Z",
      },
      {
        eventType: "reviewing",
        payload: { skillId: "review-code", taskId: 7 },
        createdAt: "2026-09-14T18:01:00.000Z",
      },
    ],
  }),
  getTask: vi.fn().mockImplementation((id: number) =>
    Promise.resolve({
      task: {
        id,
        upstreamTaskId: `upstream-${id}`,
        callerAgentId: "fleet",
        targetAgentId: "reviewer-agent",
        skillId: "review-code",
        state: id === 7 ? "running" : "done",
        result: null,
        deadlineAt: "2026-09-14T19:00:00.000Z",
        createdAt: "2026-09-14T18:00:15.000Z",
        updatedAt: "2026-09-14T18:01:00.000Z",
      },
    }),
  ),
}));

vi.mock("../authClient.ts", () => ({ signOut: vi.fn() }));

import { getTask } from "../api.ts";
import { RunDetail } from "./RunDetail.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/runs/41"]}>
      <Routes>
        <Route path="/app/runs/:runId" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetail mission control", () => {
  it("shows the real workflow, agents, latest active step, and blocker", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByText("ship-change").length).toBeGreaterThan(0));

    expect(screen.getByText("reviewer-agent")).toBeTruthy();
    expect(screen.getByText("review-code")).toBeTruthy();
    expect(screen.getByText("Task #7 has not returned yet.")).toBeTruthy();
    expect(screen.getByText("WAITING FOR CALLBACK")).toBeTruthy();
    expect(document.querySelectorAll(".mission-step.current")).toHaveLength(1);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(screen.getByText("issue-41")).toBeTruthy();
  });
});
