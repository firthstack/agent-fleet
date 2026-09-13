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

import { getWorkflow, type WorkflowDefinition } from "../api.ts";
import { WorkflowEditor } from "./WorkflowEditor.tsx";

/** A minimal published workflow — the state the main viewing use case
 *  (watching an existing definition, not authoring one) actually opens on. */
const publishedDefinition: WorkflowDefinition = {
  workflow: "demo",
  version: 1,
  start: [{ goto: "reviewing" }],
  states: {
    reviewing: { status: "active", next: [{ goto: "done" }] },
    done: { status: "terminal" },
  },
};

function validationHeadings() {
  return screen
    .queryAllByRole("heading", { level: 2 })
    .filter((h) => h.textContent?.startsWith("Validation"));
}

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

  it("collapses Publish and Validation on Done, keeps the diagram, and reopening preserves the edited text and format", async () => {
    vi.mocked(getWorkflow).mockResolvedValueOnce({
      id: 1,
      name: "demo",
      version: 1,
      definition: publishedDefinition,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText("Start a run")).toBeTruthy());
    expect(document.querySelector(".diagram")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("button", { name: /publish/i })).toBeTruthy();
    expect(validationHeadings().length).toBe(1);
    expect(document.querySelector(".diagram")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    expect(screen.getByRole("button", { name: "YAML" }).getAttribute("aria-pressed")).toBe("true");

    const textarea = document.querySelector("textarea.code") as HTMLTextAreaElement;
    const edited = `${textarea.value}\n# edited while reviewing`;
    fireEvent.change(textarea, { target: { value: edited } });

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    expect(document.querySelector("textarea.code")).toBeNull();
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
    expect(validationHeadings().length).toBe(0);
    expect(document.querySelector(".diagram")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect((document.querySelector("textarea.code") as HTMLTextAreaElement).value).toBe(edited);
    expect(screen.getByRole("button", { name: "YAML" }).getAttribute("aria-pressed")).toBe("true");
  });
});
