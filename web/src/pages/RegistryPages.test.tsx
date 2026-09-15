// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../api.ts", () => ({
  getMe: vi.fn().mockResolvedValue({
    user: { email: "dev@example.com" },
    tenant: { slug: "acme" },
  }),
  listAgents: vi.fn().mockResolvedValue({
    agents: [
      {
        agentId: "reviewer-agent",
        displayName: "Review Agent",
        endpointUrl: "https://reviewer.example/a2a",
        health: "healthy",
        skills: [
          { id: "review-code", name: "Review code", description: "", inputSchema: null },
          { id: "summarize-pr", name: "Summarize PR", description: "", inputSchema: null },
        ],
        cardFetchedAt: "2026-09-14T18:00:00.000Z",
        lastSeenAt: "2026-09-14T18:02:00.000Z",
        stats: {
          totalRuns: 8,
          succeeded: 7,
          failed: 0,
          running: 1,
          runningSince: "2026-09-14T18:01:00.000Z",
          lastRunStartedAt: "2026-09-14T17:00:00.000Z",
          lastRunEndedAt: "2026-09-14T17:04:00.000Z",
        },
      },
    ],
  }),
  listWorkflows: vi.fn().mockResolvedValue({
    workflows: [
      { id: 1, name: "ship-change", version: 1 },
      { id: 3, name: "ship-change", version: 2 },
      { id: 4, name: "triage-issue", version: 1 },
    ],
  }),
}));

vi.mock("../authClient.ts", () => ({ signOut: vi.fn() }));

import { Agents } from "./Agents.tsx";
import { Workflows } from "./Workflows.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("dashboard registries", () => {
  it("renders agents as an operational registry without dropping activity or skills", async () => {
    render(
      <MemoryRouter initialEntries={["/app/agents"]}>
        <Routes><Route path="/app/agents" element={<Agents />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("Review Agent")).toBeTruthy());
    expect(document.querySelector(".registry-table")).toBeTruthy();
    expect(screen.getAllByText("healthy")).toHaveLength(2);
    expect(screen.getByText("review-code")).toBeTruthy();
    expect(screen.getByText("summarize-pr")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByRole("link", { name: /connect agent/i })).toBeTruthy();
  });

  it("rolls workflow versions up by identity and preserves the new-definition route", async () => {
    render(
      <MemoryRouter initialEntries={["/app/workflows"]}>
        <Routes>
          <Route path="/app/workflows" element={<Workflows />} />
          <Route path="/app/workflows/:name" element={<p>Editor reached</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("ship-change")).toBeTruthy());
    expect(screen.getByText("v2")).toBeTruthy();
    expect(
      [...document.querySelectorAll(".workflow-history")].some(
        (element) => element.textContent === "2 versions",
      ),
    ).toBe(true);
    expect(screen.getByText("triage-issue")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Workflow name"), {
      target: { value: "release-train" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open editor/i }));
    expect(await screen.findByText("Editor reached")).toBeTruthy();
  });
});
