import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Landing } from "./pages/Landing.tsx";
import { Login } from "./pages/Login.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Agents } from "./pages/Agents.tsx";
import { AgentNew } from "./pages/AgentNew.tsx";
import { AgentDetail } from "./pages/AgentDetail.tsx";
import { Workflows } from "./pages/Workflows.tsx";
import { Runs } from "./pages/Runs.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { ChunkBoundary } from "./components/ChunkBoundary.tsx";

/**
 * The workflow editor is the one route loaded on demand.
 *
 * It is the only thing that reaches a YAML parser and the state-graph
 * renderer, and together those are about a quarter of the application. Every
 * other page — the landing page most of all — was paying for a screen it may
 * never open. Splitting here costs one network round trip the first time
 * somebody edits a definition, which is a page they arrive at deliberately.
 *
 * `lazy` wants a module whose default export is the component; this one is
 * named, hence the shim.
 */
const WorkflowEditor = lazy(() =>
  import("./pages/WorkflowEditor.tsx").then((m) => ({ default: m.WorkflowEditor })),
);

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/app" element={<Dashboard />} />
      <Route path="/app/agents" element={<Agents />} />
      {/* Static before dynamic, so /app/agents/new is never read as an id. */}
      <Route path="/app/agents/new" element={<AgentNew />} />
      <Route path="/app/agents/:agentId" element={<AgentDetail />} />
      <Route path="/app/workflows" element={<Workflows />} />
      <Route
        path="/app/workflows/:name"
        element={
          // The boundary is outside: a chunk that never arrives rejects the
          // import, which Suspense does not handle — only an error boundary
          // does, and without one the whole tree goes blank.
          <ChunkBoundary>
            {/* The same wording the signed-in frame uses while it resolves
                the session, so a split chunk does not announce itself as a
                different kind of wait. */}
            <Suspense fallback={<p className="center-note">Loading…</p>}>
              <WorkflowEditor />
            </Suspense>
          </ChunkBoundary>
        }
      />
      <Route path="/app/runs" element={<Runs />} />
      <Route path="/app/runs/:runId" element={<RunDetail />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
