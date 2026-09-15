import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getRun,
  getRunEvents,
  getTask,
  type RunEvent,
  type Task,
  type WorkflowRun,
} from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { ago, isTerminal, runTone } from "../runFormat.ts";
import { buildTimeline, glyphOf, verdictOf, type TimelineStep } from "../runTimeline.ts";

const POLL_MS = 5000;

function recordOf(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workflowNameOf(events: RunEvent[], run: WorkflowRun): string {
  const created = events.find((event) => event.eventType === "created");
  const workflow = recordOf(created?.payload).workflow;
  return typeof workflow === "string" && workflow ? workflow : `workflow #${run.workflowId}`;
}

function taskIdsOf(events: RunEvent[]): number[] {
  return [
    ...new Set(
      events
        .map((event) => recordOf(event.payload).taskId)
        .filter((id): id is number => typeof id === "number" && Number.isInteger(id)),
    ),
  ];
}

function duration(start: string | undefined, end: string | null): string {
  if (!start) return "—";
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function taskTone(state: Task["state"]): string {
  if (state === "done") return "ok";
  if (state === "failed" || state === "cancelled" || state === "timed_out") return "bad";
  if (state === "done_pending_notify") return "warn";
  return "live";
}

function taskIsSettled(state: Task["state"]): boolean {
  return state === "done" || state === "failed" || state === "cancelled" || state === "timed_out";
}

interface Participant {
  agentId: string;
  state: Task["state"];
  skills: string[];
}

function participantsOf(tasks: Task[]): Participant[] {
  const participants = new Map<string, Participant>();
  for (const task of tasks) {
    const current = participants.get(task.targetAgentId);
    participants.set(task.targetAgentId, {
      agentId: task.targetAgentId,
      state: task.state,
      skills: [...new Set([...(current?.skills ?? []), task.skillId])],
    });
  }
  return [...participants.values()];
}

function MissionTimeline({ run, events }: { run: WorkflowRun; events: RunEvent[] }) {
  const steps = buildTimeline(events).slice().reverse();
  if (steps.length === 0) return <p className="lead">No steps recorded yet.</p>;
  let currentIndex = -1;
  if (!isTerminal(run.state)) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index].label === run.state) {
        currentIndex = index;
        break;
      }
    }
  }

  return (
    <ol className="mission-path">
      {steps.map((step, index) => {
        const current = index === currentIndex;
        return (
          <MissionStep
            key={`${step.at}-${index}`}
            step={step}
            number={index + 1}
            current={current}
            awaitingTaskId={current ? run.awaitingTaskId : null}
          />
        );
      })}
    </ol>
  );
}

function MissionStep({
  step,
  number,
  current,
  awaitingTaskId,
}: {
  step: TimelineStep;
  number: number;
  current: boolean;
  awaitingTaskId: number | null;
}) {
  const tone = current && awaitingTaskId ? "blocked" : step.tone;
  return (
    <li className={`mission-step ${tone}${current ? " current" : ""}`}>
      <div className="mission-node">
        <span className="mission-number">{String(number).padStart(2, "0")}</span>
        <div className="mission-node-copy">
          <div className="mission-node-title">
            <code>{step.label}</code>
            {step.code ? <span className="pill bad">{step.code}</span> : null}
          </div>
          {step.note ? <p>{step.note}</p> : null}
          <small>{new Date(step.at).toLocaleTimeString()}</small>
        </div>
        <span className="mission-node-state">
          <i aria-hidden="true">{tone === "blocked" ? "!" : glyphOf(step.tone)}</i>
          {current ? "current" : step.tone === "ok" ? "done" : step.tone}
        </span>
      </div>

      {current && awaitingTaskId ? (
        <div className="mission-blocker">
          <span>WAITING FOR CALLBACK</span>
          <p>Task #{awaitingTaskId} has not returned yet.</p>
          <small>Last run activity {ago(step.at)} ago · Fleet will continue when the callback arrives.</small>
        </div>
      ) : null}

      {step.rest ? (
        <details className="mission-payload">
          <summary>event payload</summary>
          <pre className="schema">{JSON.stringify(step.rest, null, 2)}</pre>
        </details>
      ) : null}

      {step.gap ? (
        <span className={step.gap.slow ? "mission-gap slow" : "mission-gap"}>
          +{step.gap.text}
        </span>
      ) : null}
    </li>
  );
}

function MissionControl({
  run,
  events,
  tasks,
}: {
  run: WorkflowRun;
  events: RunEvent[];
  tasks: Task[];
}) {
  const workflowName = workflowNameOf(events, run);
  const participants = useMemo(() => participantsOf(tasks), [tasks]);
  const firstEvent = events[0]?.createdAt;
  const elapsed = duration(firstEvent, isTerminal(run.state) ? run.updatedAt : null);
  const verdict = verdictOf(run, buildTimeline(events));

  return (
    <div className="mission-control">
      <header className="mission-bar">
        <div className="mission-brand"><i /> Fleet</div>
        <div className="mission-crumbs">
          <Link to="/app/runs">runs</Link><b>/</b><span>#{run.id}</span>
        </div>
        <span className={`mission-run-state ${runTone(run.state)}`}>
          <i /> {run.state}
        </span>
      </header>

      <div className="mission-body">
        <aside className="mission-summary">
          <p className="mission-label">RUN</p>
          <h2>{workflowName}</h2>
          <p className="mission-id">run_{run.id}</p>

          <div className="mission-metrics">
            <div><strong>{participants.length}</strong><span>agents</span></div>
            <div><strong>{elapsed}</strong><span>elapsed</span></div>
            <div><strong>{run.awaitingTaskId ? 1 : 0}</strong><span>waiting</span></div>
          </div>

          <p className="mission-label">AGENTS</p>
          <div className="mission-agents">
            {participants.length === 0 ? (
              <p>No agent dispatched yet.</p>
            ) : (
              participants.map((participant) => (
                <div key={participant.agentId}>
                  <i className={taskTone(participant.state)} />
                  <span>
                    <strong>{participant.agentId}</strong>
                    <small>{participant.skills.join(" · ")}</small>
                  </span>
                  <em>{participant.state.replaceAll("_", " ")}</em>
                </div>
              ))
            )}
          </div>

          <div className="mission-source">
            <p className="mission-label">SOURCE</p>
            <code>{run.sourceType}</code>
            <span>{run.sourceRef}</span>
          </div>

          <details className="mission-vars">
            <summary>Variables</summary>
            <pre className="schema">{JSON.stringify(run.vars, null, 2)}</pre>
          </details>
        </aside>

        <main className="mission-canvas">
          <div className="mission-canvas-head">
            <div>
              <span className="mission-label">WORKFLOW</span>
              <strong>{workflowName}</strong>
            </div>
            <span className="mission-clock">{elapsed}</span>
          </div>

          <p className={`mission-verdict ${verdict.tone}`}>
            <span aria-hidden="true">{glyphOf(verdict.tone)}</span>
            {verdict.text}
          </p>

          <MissionTimeline run={run} events={events} />
        </main>
      </div>
    </div>
  );
}

/** `/app/runs/:id` — the run, its participants, execution path and blocker. */
export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const id = Number(runId);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const taskCache = useRef(new Map<number, Task>());

  useEffect(() => {
    setRun(null);
    setEvents([]);
    setTasks([]);
    taskCache.current.clear();
    if (!Number.isInteger(id)) {
      setError("not a run id");
      return;
    }
    setError(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      let terminal = false;
      try {
        const [runRes, eventRes] = await Promise.all([getRun(id), getRunEvents(id)]);
        const taskResults = await Promise.all(
          taskIdsOf(eventRes.events).map(async (taskId) => {
            const cached = taskCache.current.get(taskId);
            if (cached && taskIsSettled(cached.state)) return cached;
            return getTask(taskId)
              .then(({ task }) => {
                taskCache.current.set(taskId, task);
                return task;
              })
              .catch(() => null);
          }),
        );
        if (!live) return;
        setRun(runRes.run);
        setEvents(eventRes.events);
        setTasks(taskResults.filter((task): task is Task => task !== null));
        setError(null);
        terminal = isTerminal(runRes.run.state);
      } catch (err) {
        if (live) setError((err as { message: string }).message);
      } finally {
        if (live && !terminal) timer = setTimeout(() => void load(), POLL_MS);
      }
    };

    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return (
    <Shell>
      {() => (
        <div className="run-mission-page">
          {error ? <p className="error">{error}</p> : null}
          {!run ? (
            error ? null : <p className="lead">Loading run…</p>
          ) : (
            <MissionControl run={run} events={events} tasks={tasks} />
          )}
        </div>
      )}
    </Shell>
  );
}
