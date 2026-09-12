import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listAgents, type Agent } from "../api.ts";
import { HealthPill, Shell } from "../components/Shell.tsx";

/** `/app/agents` — the tenant's registry (docs/fleet-console.md §4). */
export function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err: { message: string }) => setError(err.message));
  }, []);

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <h1>Agents</h1>
            <p>
              Any A2A server: it publishes a card, accepts a message, and calls back
              when the work is done.
            </p>
          </div>

          {error ? <div className="error">{error}</div> : null}

          {agents === null && !error ? <p className="center-note">Loading…</p> : null}

          {agents && agents.length > 0 ? (
            <ul className="rows">
              {agents.map((agent) => (
                <li key={agent.agentId} className="row">
                  <div className="row-head">
                    <Link to={`/app/agents/${encodeURIComponent(agent.agentId)}`}>
                      <code>{agent.agentId}</code>
                    </Link>
                    <HealthPill health={agent.health} />
                  </div>
                  <p className="row-sub">{agent.endpointUrl}</p>
                  <p className="row-sub">
                    {agent.skills.length > 0
                      ? agent.skills.map((s) => s.id).join(" · ")
                      : "no skills on the card"}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}

          {agents && agents.length === 0 ? (
            <div className="panel">
              <div className="empty">
                <p className="lead">No agents registered.</p>
              </div>
            </div>
          ) : null}

          <p className="actions">
            <Link className="btn" to="/app/agents/new">
              Connect an agent
            </Link>
          </p>
        </>
      )}
    </Shell>
  );
}
