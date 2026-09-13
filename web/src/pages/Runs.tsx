import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listRuns, type WorkflowRun } from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { ago, isTerminal, isWaitingForSlot, runTone } from "../runFormat.ts";

/**
 * `/app/runs` (docs/fleet-console.md §4) — the standalone viewer's job, now
 * behind a session. It asks for nothing: the tenant comes from the cookie.
 *
 * Polling, not SSE. The server does know when a run moves (§12), but a poll
 * that costs one query every five seconds is not the thing to replace first.
 */
const POLL_MS = 5000;

/**
 * One character that survives a squint. Filled ring = finished either way,
 * hollow = not started, solid = in flight — the state name carries the rest,
 * and the colour carries which kind of finished.
 */
function runGlyph(run: WorkflowRun): string {
  if (isWaitingForSlot(run)) return "○";
  return isTerminal(run.state) ? "◉" : "●";
}

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

  const live = runs ?? [];
  // Oldest first: that is the order slots are handed out in, so it is also
  // the order the queue has to be read in.
  const queue = live.filter(isWaitingForSlot).sort((a, b) => a.id - b.id);
  const active = live.filter((run) => !isTerminal(run.state) && !isWaitingForSlot(run)).length;

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
                {active > 0 ? `, ${active} still moving` : ", none in flight"}
                {queue.length > 0
                  ? `, ${queue.length} waiting for a slot`
                  : ""}
                .
              </p>
              <div className="run-table">
                {runs.map((run) => {
                  const waiting = isWaitingForSlot(run);
                  const ahead = waiting ? queue.findIndex((q) => q.id === run.id) : -1;
                  return (
                    <Link
                      to={`/app/runs/${run.id}`}
                      key={run.id}
                      className="run-row"
                    >
                      <span className="run-id">#{run.id}</span>
                      <span className="run-what">{run.status}</span>
                      <span className={`pill ${waiting ? "" : runTone(run.state)}`}>
                        <span className="glyph">{runGlyph(run)}</span>
                        {waiting ? "queued" : run.state}
                      </span>
                      <span className="run-src">
                        {run.sourceType} · {run.sourceRef}
                      </span>
                      <span className="run-note">
                        {run.reason
                          ? run.reason
                          : run.awaitingTaskId
                            ? `on task ${run.awaitingTaskId}`
                            : waiting
                              ? ahead === 0
                                ? "next in line"
                                : `${ahead} ahead`
                              : ""}
                      </span>
                      <span className="run-age" title={run.updatedAt ?? ""}>
                        {ago(run.updatedAt)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
