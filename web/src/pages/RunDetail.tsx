import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getRun, getRunEvents, type RunEvent, type WorkflowRun } from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { ago, isTerminal, runTone } from "../runFormat.ts";
import { buildTimeline, glyphOf, verdictOf, type TimelineStep } from "../runTimeline.ts";

const POLL_MS = 5000;

/**
 * The run, read down a rail: newest at the top, where it started at the
 * bottom.
 *
 * The old version was a list of rows with the raw payload under each, which
 * put a scrolling code block between every pair of steps and made the one
 * that failed look like all the others. Here the failure is the only red mark
 * on the rail, and the gaps sit on the segments between the nodes — the same
 * reading the landing page's state graph asks for.
 */
function Timeline({ events }: { events: RunEvent[] }) {
  const steps = buildTimeline(events);
  if (steps.length === 0) return <p className="lead">No steps recorded yet.</p>;
  return (
    <ol className="rail">
      {steps.map((step, i) => (
        <Step key={`${step.at}-${i}`} step={step} />
      ))}
    </ol>
  );
}

function Step({ step }: { step: TimelineStep }) {
  return (
    <li className={`rail-step ${step.tone}`}>
      <span className="rail-node" aria-hidden="true">
        {glyphOf(step.tone)}
      </span>
      <div className="rail-body">
        <div className="rail-head">
          <code className="rail-state">{step.label}</code>
          {step.code ? <span className="pill bad">{step.code}</span> : null}
          <span className="spacer" />
          <span className="age">{new Date(step.at).toLocaleTimeString()}</span>
        </div>
        {step.note ? <p className="rail-note">{step.note}</p> : null}
        {step.rest ? (
          <details className="rail-more">
            <summary>payload</summary>
            <pre className="schema">{JSON.stringify(step.rest, null, 2)}</pre>
          </details>
        ) : null}
      </div>
      {step.gap ? (
        <span className={step.gap.slow ? "rail-gap slow" : "rail-gap"}>+{step.gap.text}</span>
      ) : null}
    </li>
  );
}

/**
 * What happened, in one line.
 *
 * It gets a line of its own rather than a clause on the end of the
 * provenance: on a failed run this is the reason the page was opened, and it
 * was previously a trailing ` · reason` most people's eyes slid past.
 */
function Verdict({ run, events }: { run: WorkflowRun; events: RunEvent[] }) {
  const verdict = verdictOf(run, buildTimeline(events));
  return (
    <p className={`verdict ${verdict.tone}`}>
      <span aria-hidden="true">{glyphOf(verdict.tone)}</span> {verdict.text}
    </p>
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
                </p>
                <Verdict run={run} events={events} />
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

              {/* Stacked, not side by side: both of these are wide things —
                  a JSON block and a labelled rail — and in half a page each
                  they spent their width on scrollbars. */}
              <div className="panel stack">
                <h2>Timeline</h2>
                <p className="hint">
                  Newest first. Each gap is the time since the step below it.
                </p>
                <Timeline events={events} />
              </div>

              <div className="panel stack">
                <h2>Variables</h2>
                <p className="hint">What the definition accumulated on the way here.</p>
                <pre className="schema">{JSON.stringify(run.vars, null, 2)}</pre>
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
