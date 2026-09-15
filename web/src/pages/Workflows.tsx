import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listWorkflows, type WorkflowSummary } from "../api.ts";
import { Shell } from "../components/Shell.tsx";

interface WorkflowRollup {
  name: string;
  latestVersion: number;
  latestId: number;
  versions: number;
}

function rollupWorkflows(workflows: WorkflowSummary[]): WorkflowRollup[] {
  const byName = new Map<string, WorkflowRollup>();
  for (const workflow of workflows) {
    const current = byName.get(workflow.name);
    byName.set(workflow.name, {
      name: workflow.name,
      latestVersion: Math.max(current?.latestVersion ?? 0, workflow.version),
      latestId:
        !current || workflow.version >= current.latestVersion ? workflow.id : current.latestId,
      versions: (current?.versions ?? 0) + 1,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `/app/workflows` — published state machines and the entry to a new definition. */
export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    listWorkflows()
      .then((res) => setWorkflows(res.workflows))
      .catch((err: { message: string }) => setError(err.message));
  }, []);

  const definitions = useMemo(() => rollupWorkflows(workflows ?? []), [workflows]);
  const highestVersion = definitions.reduce(
    (highest, workflow) => Math.max(highest, workflow.latestVersion),
    0,
  );

  const openEditor = () => {
    const slug = name.trim();
    if (slug) navigate(`/app/workflows/${encodeURIComponent(slug)}`);
  };

  return (
    <Shell>
      {() => (
        <div className="registry-page">
          <div className="page-head control-page-head">
            <div>
              <span className="control-kicker">MISSION DEFINITIONS</span>
              <h1>Workflows</h1>
              <p>State machines that coordinate skills across the fleet and keep every handoff observable.</p>
            </div>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <form
            className="workflow-launcher"
            onSubmit={(event) => {
              event.preventDefault();
              openEditor();
            }}
          >
            <div className="workflow-launcher-copy">
              <span className="control-kicker">NEW WORKFLOW</span>
              <strong>Open a definition</strong>
              <small>The name becomes its stable identity; each publish creates a new version.</small>
            </div>
            <div className="workflow-launcher-form">
              <span aria-hidden="true">wf /</span>
              <input
                aria-label="Workflow name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="develop-review-merge"
                required
              />
              <button className="btn" type="submit">Open editor <span aria-hidden="true">→</span></button>
            </div>
          </form>

          {workflows === null ? (
            <p className="center-note">Loading…</p>
          ) : (
            <>
              <div className="registry-metrics workflow-metrics" aria-label="Workflow summary">
                <div><strong>{definitions.length}</strong><span>definitions</span></div>
                <div><strong>{workflows.length}</strong><span>versions</span></div>
                <div><strong>{highestVersion || "—"}</strong><span>highest version</span></div>
              </div>

              {definitions.length === 0 ? (
                <div className="registry-empty">
                  <span aria-hidden="true">◇</span>
                  <div>
                    <strong>No workflows published</strong>
                    <p>Name a workflow above to open the editor and validate its first definition.</p>
                  </div>
                </div>
              ) : (
                <div className="registry-table">
                  <div className="registry-table-head workflow-registry-grid" aria-hidden="true">
                    <span>WORKFLOW</span>
                    <span>LATEST</span>
                    <span>HISTORY</span>
                    <span>IDENTITY</span>
                    <span />
                  </div>
                  {definitions.map((workflow) => (
                    <Link
                      to={`/app/workflows/${encodeURIComponent(workflow.name)}`}
                      key={workflow.name}
                      className="registry-row workflow-registry-grid"
                    >
                      <span className="registry-primary workflow-identity">
                        <i className="workflow-mark" aria-hidden="true">◇</i>
                        <span>
                          <strong>{workflow.name}</strong>
                          <small>published state machine</small>
                        </span>
                      </span>
                      <span className="workflow-version"><span className="pill live">v{workflow.latestVersion}</span></span>
                      <span className="workflow-history">
                        <strong>{workflow.versions}</strong>
                        <small> version{workflow.versions === 1 ? "" : "s"}</small>
                      </span>
                      <code className="workflow-ref">wf_{workflow.latestId} / {workflow.name}</code>
                      <span className="registry-arrow" aria-hidden="true">→</span>
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Shell>
  );
}
