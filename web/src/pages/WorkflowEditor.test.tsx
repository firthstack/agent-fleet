// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// WorkflowEditor and the Shell it renders inside both talk to the API on
// mount. Stubbed here so the test exercises only the edit-toggle, not a
// real backend — see agent-fleet#6.
vi.mock("../api.ts", () => ({
  getMe: vi.fn().mockResolvedValue({ user: { email: "dev@example.com" }, tenant: { slug: "acme" } }),
  listWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
  getWorkflow: vi.fn().mockResolvedValue(null),
  validateWorkflow: vi.fn().mockResolvedValue({ issues: [], warnings: [] }),
  publishWorkflow: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock("../authClient.ts", () => ({
  signOut: vi.fn(),
}));

import { WorkflowEditor } from "./WorkflowEditor.tsx";

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/workflows/demo"]}>
      <Routes>
        <Route path="/app/workflows/:name" element={<WorkflowEditor />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkflowEditor edit toggle", () => {
  it("shows the state machine but hides the definition editor and publish form by default", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("Start a run")).toBeTruthy());

    expect(screen.getByText("States")).toBeTruthy();
    expect(document.querySelector("textarea.code")).toBeNull();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy();
  });

  it("reveals the definition editor and publish form after Edit is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("Start a run")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    expect(document.querySelector("textarea.code")).not.toBeNull();
    expect(screen.getByRole("button", { name: /publish/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(document.querySelector("textarea.code")).toBeNull();
  });
});
