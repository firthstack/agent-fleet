import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listRuns, type WorkflowRun } from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { ago, isTerminal, runTone } from "../runFormat.ts";

/**
 * `/app/runs` (docs/fleet-console.md §4) — the standalone viewer's job, now
 * behind a session. It asks for nothing: the tenant comes from the cookie.
 *
 * Polling, not SSE. The server does know when a run moves (§12), but a poll
 * that costs one query every five seconds is not the thing to replace first.
 */
const POLL_MS = 5000;

export function Runs() {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      listRuns()
        .then((res) => {
          if (!live) return;
          setRuns(res.runs);
          setError(null);
        })
        .catch((err: { message: string }) => live && setError(err.message));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const active = (runs ?? []).filter((run) => !isTerminal(run.state)).length;

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <h1>Runs</h1>
            <p>
              Every run this tenant has started, newest first, with how long each
              has sat in the state it is in.
            </p>
          </div>

          {error ? <p className="error">{error}</p> : null}

          {runs === null ? (
            <p className="lead">Loading…</p>
          ) : runs.length === 0 ? (
            <div className="empty">
              <p className="lead">No runs yet.</p>
              <p className="lead">
                Publish a workflow and start one from{" "}
                <Link to="/app/workflows">Workflows</Link>.
              </p>
            </div>
          ) : (
            <>
              <p className="hint">
                {runs.length} run{runs.length > 1 ? "s" : ""}
                {active > 0 ? `, ${active} still moving` : ", none in flight"}.
              </p>
              <ul className="rows">
                {runs.map((run) => (
                  <li key={run.id} className="row">
                    <div className="row-head">
                      <Link to={`/app/runs/${run.id}`}>
                        <code>#{run.id}</code>
                      </Link>
                      <span className="row-name">{run.status}</span>
                      <span className={`pill ${runTone(run.state)}`}>{run.state}</span>
                      <span className="spacer" />
                      <span className="age" title={run.updatedAt ?? ""}>
                        {ago(run.updatedAt)}
                      </span>
                    </div>
                    <p className="row-sub">
                      <code>{run.sourceType}</code> · <code>{run.sourceRef}</code>
                      {run.reason ? ` · ${run.reason}` : ""}
                      {run.awaitingTaskId ? ` · waiting on task ${run.awaitingTaskId}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
