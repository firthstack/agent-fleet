import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listAgents, type Agent } from "../api.ts";
import { HealthPill, Shell } from "../components/Shell.tsx";
import { ago, lastRunSummary } from "../runFormat.ts";

/** The run counts a card shows: how much it has done, and whether any of it
 *  is still in flight (title captures both — issue #3). */
function AgentStats({ stats }: { stats: Agent["stats"] }) {
  if (stats.totalRuns === 0) {
    return <p className="row-sub">no runs yet</p>;
  }
  const lastRun = lastRunSummary(stats.lastRunStartedAt, stats.lastRunEndedAt);
  return (
    <>
      <p className="row-sub agent-stats" title="Snapshot as of page load — refresh to update">
        <span>{stats.totalRuns} run{stats.totalRuns === 1 ? "" : "s"}</span>
        {stats.succeeded > 0 ? <span className="pill ok">{stats.succeeded} ok</span> : null}
        {stats.failed > 0 ? <span className="pill bad">{stats.failed} failed</span> : null}
        {stats.running > 0 ? (
          <span className="pill live" title={stats.runningSince ?? ""}>
            {stats.running} running{stats.runningSince ? ` · ${ago(stats.runningSince)}` : ""}
          </span>
        ) : null}
      </p>
      {lastRun ? (
        <p className="row-sub" title={lastRun.title}>
          {lastRun.text}
        </p>
      ) : null}
    </>
  );
}

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
            <ul className="agent-cards">
              {agents.map((agent) => (
                <li key={agent.agentId} className="agent-card">
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
                  <AgentStats stats={agent.stats} />
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
