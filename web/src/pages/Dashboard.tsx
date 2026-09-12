import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listAgents,
  listRuns,
  listWorkflows,
  type Agent,
  type WorkflowRun,
  type WorkflowSummary,
} from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { isTerminal } from "../runFormat.ts";

/** `/app` — the overview. Each panel is a door to the page that owns it. */
export function Dashboard() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);

  useEffect(() => {
    listAgents()
      .then((res) => setAgents(res.agents))
      .catch(() => setAgents(null));
    listWorkflows()
      .then((res) => setWorkflows(res.workflows))
      .catch(() => setWorkflows(null));
    listRuns(20)
      .then((res) => setRuns(res.runs))
      .catch(() => setRuns(null));
  }, []);

  const unreachable = (agents ?? []).filter((a) => a.health !== "healthy").length;
  const names = new Set((workflows ?? []).map((w) => w.name));
  const active = (runs ?? []).filter((run) => !isTerminal(run.state));

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <h1>Dashboard</h1>
            <p>
              Agents register here, workflows compose them, and every run they
              produce is a row this gateway owns.
            </p>
          </div>

          <div className="grid-2">
            <div className="panel">
              <h2>Agents</h2>
              <p className="hint">
                Any A2A server: it publishes a card, accepts a message, and calls
                back when the work is done.
              </p>
              {agents === null ? (
                <p className="lead">Loading…</p>
              ) : agents.length === 0 ? (
                <div className="empty">
                  <p className="lead">No agents registered.</p>
                </div>
              ) : (
                <p className="lead">
                  {agents.length} registered
                  {unreachable > 0 ? `, ${unreachable} not healthy` : ""}.
                </p>
              )}
              <p className="actions">
                <Link className="btn ghost" to="/app/agents">
                  Agents
                </Link>
                <Link className="btn" to="/app/agents/new">
                  Connect an agent
                </Link>
              </p>
            </div>

            <div className="panel">
              <h2>Workflows</h2>
              <p className="hint">
                A state machine this gateway owns, composing the skills your agents
                advertise.
              </p>
              {workflows === null ? (
                <p className="lead">Loading…</p>
              ) : names.size === 0 ? (
                <div className="empty">
                  <p className="lead">No workflows published.</p>
                </div>
              ) : (
                <p className="lead">
                  {names.size} definition{names.size > 1 ? "s" : ""} across{" "}
                  {workflows.length} version{workflows.length > 1 ? "s" : ""}.
                </p>
              )}
              <p className="actions">
                <Link className="btn ghost" to="/app/workflows">
                  Workflows
                </Link>
              </p>
            </div>

            <div className="panel">
              <h2>Runs</h2>
              <p className="hint">
                Every step of every run, with how long it has sat where it is.
              </p>
              {runs === null ? (
                <p className="lead">Loading…</p>
              ) : runs.length === 0 ? (
                <div className="empty">
                  <p className="lead">No runs yet.</p>
                </div>
              ) : (
                <p className="lead">
                  {runs.length} recent
                  {active.length > 0
                    ? `, ${active.length} still moving.`
                    : ", none in flight."}
                </p>
              )}
              <p className="actions">
                <Link className="btn ghost" to="/app/runs">
                  Runs
                </Link>
              </p>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
