import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getWorkflow,
  listWorkflows,
  publishWorkflow,
  startRun,
  validateWorkflow,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "../api.ts";
import { Shell } from "../components/Shell.tsx";
import { StateDiagram } from "../components/StateDiagram.tsx";

/**
 * `/app/workflows/:name` (docs §7) — code on the left, the graph on the
 * right, validation underneath.
 *
 * The rules are never reimplemented here. `validateDefinition` runs on the
 * server and this page asks it; a second copy in the browser would drift from
 * the one that actually gates publishing, and the drift would show up as a
 * definition the editor called fine and the server refused.
 */

const TEMPLATE = `{
  "workflow": "NAME",
  "version": 1,
  "start": [{ "goto": "working" }],
  "states": {
    "working": {
      "call": { "skill": "some.skill", "payload": {} },
      "next": [
        { "when": "result.ok", "goto": "completed" },
        { "fail": "the step did not succeed" }
      ]
    }
  }
}
`;

/** Debounced so typing does not fire a request per keystroke. */
const VALIDATE_MS = 400;

function parse(text: string): { def: WorkflowDefinition | null; syntax: string | null } {
  try {
    const parsed = JSON.parse(text) as WorkflowDefinition;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { def: null, syntax: "a definition must be a JSON object" };
    }
    return { def: parsed, syntax: null };
  } catch (err) {
    return { def: null, syntax: (err as Error).message };
  }
}

function StartRun({ name, versions }: { name: string; versions: number[] }) {
  const [payload, setPayload] = useState("{}");
  const [version, setVersion] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: number; deduplicated: boolean } | null>(null);

  // One ref per distinct payload, so a double-click lands on the run the
  // first click opened instead of starting a second one (docs §8).
  const sourceRef = useMemo(() => `console-${crypto.randomUUID()}`, [payload, version]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await startRun(name, {
        payload: JSON.parse(payload) as Record<string, unknown>,
        ...(version ? { version: Number(version) } : {}),
        sourceRef,
      });
      setStarted({ id: res.run.id, deduplicated: res.deduplicated });
    } catch (err) {
      const failed = err as { message: string; status?: number };
      // 409 means the run row exists but its first step never went out —
      // usually no agent offers that skill. Saying only "failed" would leave
      // a run sitting in the list with no explanation for it.
      setError(
        failed.status === 409
          ? `${failed.message}. A run was created and is not moving; connect the agent, then start a new one.`
          : failed.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Start a run</h2>
      <p className="hint">
        The payload is what the definition's <code>vars</code> read from.
      </p>
      <form onSubmit={submit}>
        <label>
          Payload
          <textarea
            className="mono"
            rows={4}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </label>
        <label>
          Version
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">latest</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <p className="form-actions">
          <button className="btn" type="submit" disabled={busy || versions.length === 0}>
            {busy ? "Starting…" : "Start"}
          </button>
        </p>
      </form>
      {versions.length === 0 ? (
        <p className="hint">Publish a version first.</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {started ? (
        <p className="lead">
          {started.deduplicated ? "Already running as " : "Started "}
          <Link to={`/app/runs/${started.id}`}>run #{started.id}</Link>.
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowEditor() {
  const { name = "" } = useParams<{ name: string }>();
  const [text, setText] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [versions, setVersions] = useState<number[]>([]);
  const [publishAs, setPublishAs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { def, syntax } = useMemo(() => parse(text ?? "{}"), [text]);

  // Open on the latest published version, or a template when there is none.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [list, current] = await Promise.all([
        listWorkflows().catch(() => ({ workflows: [] as WorkflowSummary[] })),
        getWorkflow(name).catch(() => null),
      ]);
      if (!live) return;
      const mine = list.workflows
        .filter((w) => w.name === name)
        .map((w) => w.version)
        .sort((a, b) => b - a);
      setVersions(mine);
      setPublishAs(String((mine[0] ?? 0) + 1));
      setText(
        current
          ? JSON.stringify(current.definition, null, 2)
          : TEMPLATE.replace("NAME", name),
      );
    })();
    return () => {
      live = false;
    };
  }, [name]);

  // Validation follows the text, debounced. Invalid JSON never reaches the
  // server: there is nothing for it to check yet.
  useEffect(() => {
    if (!def) {
      setIssues(null);
      return;
    }
    let live = true;
    setChecking(true);
    const timer = setTimeout(() => {
      validateWorkflow(def)
        .then((res) => {
          if (!live) return;
          setIssues(res.issues);
          setWarnings(res.warnings ?? []);
        })
        .catch(() => live && setIssues(null))
        .finally(() => live && setChecking(false));
    }, VALIDATE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [def]);

  const publishable = def !== null && issues !== null && issues.length === 0;

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!def) return;
    setError(null);
    setNote(null);
    try {
      const version = Number(publishAs);
      const published = await publishWorkflow(name, version, def);
      setVersions((prev) => [...new Set([version, ...prev])].sort((a, b) => b - a));
      setPublishAs(String(version + 1));
      setWarnings(published.warnings ?? []);
      setNote(`Published v${version}. Runs already in flight stay on the version they started.`);
    } catch (err) {
      setError((err as { message: string }).message);
    }
  }

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <p className="crumb">
              <Link to="/app/workflows">Workflows</Link>
            </p>
            <h1>
              <code>{name}</code>
            </h1>
            <p>
              {versions.length === 0
                ? "Not published yet."
                : `v${versions[0]} is the latest of ${versions.length} published.`}
            </p>
          </div>

          <div className="editor">
            <div className="panel">
              <h2>Definition</h2>
              <textarea
                className="mono code"
                spellCheck={false}
                rows={28}
                value={text ?? ""}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <div className="panel">
              <h2>States</h2>
              <p className="hint">
                Drawn from the definition. A loop back to an earlier state runs
                up the right-hand lane — that edge is the reason this format is
                a state machine and not a DAG.
              </p>
              <StateDiagram definition={def} />
            </div>
          </div>

          <div className="panel">
            <h2>
              Validation{" "}
              {syntax ? (
                <span className="pill bad">invalid JSON</span>
              ) : checking ? (
                <span className="pill">checking…</span>
              ) : issues && issues.length > 0 ? (
                <span className="pill warn">
                  {issues.length} issue{issues.length > 1 ? "s" : ""}
                </span>
              ) : publishable ? (
                <span className="pill ok">ready</span>
              ) : null}
              {warnings.length > 0 ? (
                <span className="pill warn">
                  {warnings.length} against your fleet
                </span>
              ) : null}
            </h2>
            {syntax ? (
              <p className="error">{syntax}</p>
            ) : issues && issues.length > 0 ? (
              <ul className="rows">
                {issues.map((issue, i) => (
                  <li key={`${issue.path}-${i}`} className="row">
                    <code>{issue.path}</code> <span className="row-sub">{issue.message}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">
                The same check that gates publishing — it runs on the server, so
                what it says here is what publishing will do.
              </p>
            )}

            {warnings.length > 0 ? (
              <div className="warnings">
                <p className="hint">
                  Checked against the agents you have connected. These do not
                  stop a publish — a definition can be written before the agent
                  that serves it exists — but each one is a failure you would
                  otherwise meet part-way through a run.
                </p>
                <ul className="rows">
                  {warnings.map((warning, i) => (
                    <li key={`${warning.path}-${i}`} className="row">
                      <code>{warning.path}</code>{" "}
                      <span className="row-sub">{warning.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <form className="inline-form" onSubmit={publish}>
              <label>
                Publish as version
                <input
                  type="number"
                  min={1}
                  value={publishAs}
                  onChange={(e) => setPublishAs(e.target.value)}
                  required
                />
              </label>
              <button className="btn" type="submit" disabled={!publishable}>
                Publish
              </button>
            </form>
            {error ? <p className="error">{error}</p> : null}
            {note ? <p className="lead">{note}</p> : null}
          </div>

          <StartRun name={name} versions={versions} />
        </>
      )}
    </Shell>
  );
}
