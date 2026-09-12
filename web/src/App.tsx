import { Navigate, Route, Routes } from "react-router-dom";
import { Landing } from "./pages/Landing.tsx";
import { Login } from "./pages/Login.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Agents } from "./pages/Agents.tsx";
import { AgentNew } from "./pages/AgentNew.tsx";
import { AgentDetail } from "./pages/AgentDetail.tsx";
import { Workflows } from "./pages/Workflows.tsx";
import { WorkflowEditor } from "./pages/WorkflowEditor.tsx";
import { Runs } from "./pages/Runs.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";

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
      <Route path="/app/workflows/:name" element={<WorkflowEditor />} />
      <Route path="/app/runs" element={<Runs />} />
      <Route path="/app/runs/:runId" element={<RunDetail />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
