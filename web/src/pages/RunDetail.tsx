import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getRun, getRunEvents, type RunEvent, type WorkflowRun } from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { ago, gapBetween, isTerminal, runTone } from "../runFormat.ts";

const POLL_MS = 5000;

/** The timeline. Each entry carries the gap since the one before it, because
 *  "where did the six hours go" is the question this page exists to answer. */
function Timeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) return <p className="lead">No steps recorded yet.</p>;
  return (
    <ol className="chain">
      {events.map((event, i) => {
        const gap = i > 0 ? gapBetween(events[i - 1].createdAt, event.createdAt) : null;
        return (
          <li key={`${event.createdAt}-${i}`} className="chain-row">
            <div className="row-head">
              <code>{event.eventType}</code>
              <span className="spacer" />
              {gap ? (
                <span className={gap.slow ? "gap slow" : "gap"}>+{gap.text}</span>
              ) : null}
              <span className="age">{new Date(event.createdAt).toLocaleTimeString()}</span>
            </div>
            {event.payload != null && Object.keys(event.payload).length > 0 ? (
              <pre className="schema">{JSON.stringify(event.payload, null, 2)}</pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** `/app/runs/:id` — the run, its variables, and which step it is stuck on. */
export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const id = Number(runId);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isInteger(id)) {
      setError("not a run id");
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const [runRes, eventRes] = await Promise.all([getRun(id), getRunEvents(id)]);
        if (!live) return;
        setRun(runRes.run);
        setEvents(eventRes.events);
        setError(null);
        // A finished run cannot change again, so stop asking.
        if (isTerminal(runRes.run.state) && timer) clearInterval(timer);
      } catch (err) {
        if (live) setError((err as { message: string }).message);
      }
    };

    void load();
    timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [id]);

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <p className="crumb">
              <Link to="/app/runs">Runs</Link>
            </p>
            <h1>Run #{runId}</h1>
          </div>

          {error ? <p className="error">{error}</p> : null}
          {!run ? (
            error ? null : (
              <p className="lead">Loading…</p>
            )
          ) : (
            <>
              <div className="panel">
                <div className="row-head">
                  <span className="row-name">{run.status}</span>
                  <span className={`pill ${runTone(run.state)}`}>{run.state}</span>
                  <span className="spacer" />
                  <span className="age">updated {ago(run.updatedAt)} ago</span>
                </div>
                <p className="row-sub">
                  Started from <code>{run.sourceType}</code> ·{" "}
                  <code>{run.sourceRef}</code>
                  {run.reason ? ` · ${run.reason}` : ""}
                </p>
                {run.awaitingTaskId ? (
                  <p className="hint">
                    Waiting on task <code>{run.awaitingTaskId}</code> — the next step
                    runs when that callback arrives.
                  </p>
                ) : isTerminal(run.state) ? (
                  <p className="hint">Finished. Nothing further is dispatched.</p>
                ) : (
                  <p className="hint">No step in flight; the driver picks it up next sweep.</p>
                )}
              </div>

              <div className="grid-2">
                <div className="panel">
                  <h2>Timeline</h2>
                  <p className="hint">
                    One entry per state the run entered, with the gap since the
                    previous one.
                  </p>
                  <Timeline events={events} />
                </div>

                <div className="panel">
                  <h2>Variables</h2>
                  <p className="hint">
                    What the definition accumulated on the way here.
                  </p>
                  <pre className="schema">{JSON.stringify(run.vars, null, 2)}</pre>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
