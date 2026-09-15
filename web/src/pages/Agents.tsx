import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listAgents, type Agent } from "../api.ts";
import { HealthPill, Shell } from "../components/Shell.tsx";
import { ago, lastRunSummary } from "../runFormat.ts";

function AgentActivity({ stats }: { stats: Agent["stats"] }) {
  const lastRun = lastRunSummary(stats.lastRunStartedAt, stats.lastRunEndedAt);
  if (stats.totalRuns === 0) {
    return (
      <span className="registry-activity quiet">
        <strong>no runs</strong>
        <small>ready for work</small>
      </span>
    );
  }

  return (
    <span className="registry-activity" title="Snapshot as of page load — refresh to update">
      <strong className={stats.running > 0 ? "live" : stats.failed > 0 ? "warn" : ""}>
        {stats.running > 0
          ? `${stats.running} running`
          : `${stats.totalRuns} run${stats.totalRuns === 1 ? "" : "s"}`}
      </strong>
      <small title={lastRun?.title}>
        {stats.failed > 0
          ? `${stats.succeeded} ok · ${stats.failed} failed`
          : lastRun?.text ?? `${stats.succeeded} completed`}
      </small>
    </span>
  );
}

function lastSeen(agent: Agent): { text: string; title?: string } {
  const timestamp = agent.lastSeenAt ?? agent.cardFetchedAt;
  if (!timestamp) return { text: "never" };
  return {
    text: `${ago(timestamp)} ago`,
    title: `${agent.lastSeenAt ? "Last seen" : "Card fetched"} ${new Date(timestamp).toLocaleString()}`,
  };
}

/** `/app/agents` — the tenant's A2A registry, as an operational directory. */
export function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err: { message: string }) => setError(err.message));
  }, []);

  const registered = agents ?? [];
  const healthy = registered.filter((agent) => agent.health === "healthy").length;
  const capabilities = new Set(registered.flatMap((agent) => agent.skills.map((skill) => skill.id))).size;
  const inFlight = registered.reduce((total, agent) => total + agent.stats.running, 0);

  return (
    <Shell>
      {() => (
        <div className="registry-page">
          <div className="page-head control-page-head">
            <div>
              <span className="control-kicker">FLEET REGISTRY</span>
              <h1>Agents</h1>
              <p>Every A2A endpoint Fleet can dispatch work to, and the capabilities it exposes.</p>
            </div>
            <Link className="btn control-action" to="/app/agents/new">
              <span aria-hidden="true">＋</span> Connect agent
            </Link>
          </div>

          {error ? <div className="error">{error}</div> : null}
          {agents === null && !error ? <p className="center-note">Loading…</p> : null}

          {agents ? (
            <>
              <div className="registry-metrics" aria-label="Agent fleet summary">
                <div><strong>{registered.length}</strong><span>registered</span></div>
                <div><strong>{healthy}</strong><span>healthy</span></div>
                <div><strong>{capabilities}</strong><span>capabilities</span></div>
                <div><strong>{inFlight}</strong><span>in flight</span></div>
              </div>

              {registered.length === 0 ? (
                <div className="registry-empty">
                  <span aria-hidden="true">◇</span>
                  <div>
                    <strong>No agents connected</strong>
                    <p>Connect an A2A endpoint and Fleet will discover its skills automatically.</p>
                  </div>
                  <Link className="btn ghost small" to="/app/agents/new">Connect the first agent</Link>
                </div>
              ) : (
                <div className="registry-table">
                  <div className="registry-table-head agent-registry-grid" aria-hidden="true">
                    <span>AGENT</span>
                    <span>HEALTH</span>
                    <span>CAPABILITIES</span>
                    <span>ACTIVITY</span>
                    <span>LAST SEEN</span>
                    <span />
                  </div>
                  {registered.map((agent) => {
                    const seen = lastSeen(agent);
                    return (
                      <Link
                        to={`/app/agents/${encodeURIComponent(agent.agentId)}`}
                        key={agent.agentId}
                        className="registry-row agent-registry-grid"
                      >
                        <span className="registry-primary agent-identity">
                          <i className={`registry-dot ${agent.health}`} aria-hidden="true" />
                          <span>
                            <strong>{agent.displayName || agent.agentId}</strong>
                            <code>{agent.agentId}</code>
                            <small>{agent.endpointUrl}</small>
                          </span>
                        </span>
                        <span className="agent-health"><HealthPill health={agent.health} /></span>
                        <span className="registry-skills">
                          {agent.skills.length === 0 ? (
                            <em>no skills</em>
                          ) : (
                            <>
                              {agent.skills.slice(0, 2).map((skill) => <code key={skill.id}>{skill.id}</code>)}
                              {agent.skills.length > 2 ? <small>+{agent.skills.length - 2}</small> : null}
                            </>
                          )}
                        </span>
                        <AgentActivity stats={agent.stats} />
                        <span className="registry-seen" title={seen.title}>{seen.text}</span>
                        <span className="registry-arrow" aria-hidden="true">→</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </Shell>
  );
}
