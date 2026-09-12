import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listWorkflows, type WorkflowSummary } from "../api.ts";
import { Shell } from "../components/Shell.tsx";

/** `/app/workflows` — published definitions, newest version per name. */
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

  // One row per name, carrying its highest version: the list is a directory
  // of workflows, not of every version ever published.
  const byName = new Map<string, number>();
  for (const wf of workflows ?? []) {
    byName.set(wf.name, Math.max(byName.get(wf.name) ?? 0, wf.version));
  }

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <h1>Workflows</h1>
            <p>
              A definition this gateway owns — a state machine over the skills
              your agents advertise, not code inside any one of them.
            </p>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <div className="panel">
            <h2>New definition</h2>
            <p className="hint">
              The name is the identity; every publish under it is a version, and
              a run stays bound to the version it started on.
            </p>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                const slug = name.trim();
                if (slug) navigate(`/app/workflows/${encodeURIComponent(slug)}`);
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="develop-review-merge"
                required
              />
              <button className="btn" type="submit">
                Open editor
              </button>
            </form>
          </div>

          {workflows === null ? (
            <p className="lead">Loading…</p>
          ) : byName.size === 0 ? (
            <div className="empty">
              <p className="lead">No workflows published.</p>
              <p className="lead">
                A definition is validated before it can be published, so what
                lands here is something that can actually run.
              </p>
            </div>
          ) : (
            <ul className="rows">
              {[...byName.entries()].map(([wfName, version]) => (
                <li key={wfName} className="row">
                  <div className="row-head">
                    <Link to={`/app/workflows/${encodeURIComponent(wfName)}`}>
                      <code>{wfName}</code>
                    </Link>
                    <span className="row-name">v{version}</span>
                  </div>
                  <p className="row-sub">
                    {(workflows ?? []).filter((w) => w.name === wfName).length} version
                    {(workflows ?? []).filter((w) => w.name === wfName).length > 1 ? "s" : ""} published
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Shell>
  );
}
