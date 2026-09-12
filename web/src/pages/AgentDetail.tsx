import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  deleteAgent,
  getAgent,
  getTask,
  rotateAgentToken,
  sendAgentMessage,
  updateAgent,
  type Agent,
  type PayloadIssue,
  type Task,
} from "../api.ts";
import { HealthPill, OneTimeToken, Shell } from "../components/Shell.tsx";

/**
 * `/app/agents/:id` (docs/fleet-console.md §4): the card, the skills it
 * advertises with the schema each takes, and the three things only the owner
 * can do — rotate, change, remove.
 */

const TERMINAL: Task["state"][] = ["done", "cancelled", "failed", "timed_out"];

function Skills({ agent }: { agent: Agent }) {
  return (
    <div className="panel">
      <h2>Skills</h2>
      <p className="hint">
        Captured from the card at registration. This is what a workflow matches on
        and what a message has to name.
      </p>
      {agent.skills.length === 0 ? (
        <div className="empty">
          <p className="lead">The card advertises no skills.</p>
        </div>
      ) : (
        <ul className="rows">
          {agent.skills.map((skill) => (
            <li key={skill.id} className="row">
              <div className="row-head">
                <code>{skill.id}</code>
                <span className="row-name">{skill.name}</span>
              </div>
              <p className="row-sub">{skill.description}</p>
              {skill.inputSchema ? (
                <pre className="schema">{JSON.stringify(skill.inputSchema, null, 2)}</pre>
              ) : (
                <p className="row-sub">no input schema on the card</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** §8: a person's message. There is no callback to a browser, so the page
 *  polls the task until it stops moving. */
function SendMessage({ agent }: { agent: Agent }) {
  const [skillId, setSkillId] = useState(agent.skills[0]?.id ?? "");
  const [body, setBody] = useState("");
  const [asJson, setAsJson] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<PayloadIssue[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const skill = agent.skills.find((s) => s.id === skillId);
  const schema = skill?.inputSchema ?? null;

  const poll = useCallback((id: number) => {
    window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const { task: latest } = await getTask(id);
        setTask(latest);
        if (TERMINAL.includes(latest.state)) window.clearInterval(timer.current);
      } catch {
        // A transient failure is not worth tearing the page down over; the
        // next tick tries again.
      }
    }, 2000);
  }, []);

  useEffect(() => () => window.clearInterval(timer.current), []);

  // A skill that declares a schema is asking for a data part, so the form
  // follows the card rather than making the user notice a checkbox.
  useEffect(() => {
    setAsJson(schema !== null);
    setIssues([]);
  }, [schema]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      let payload: { skillId: string; text?: string; data?: unknown };
      if (asJson) {
        try {
          payload = { skillId, data: JSON.parse(body) };
        } catch {
          setError("that is not valid JSON");
          return;
        }
      } else {
        payload = { skillId, text: body };
      }
      const { task: created } = await sendAgentMessage(agent.agentId, payload);
      setTask(created);
      poll(created.id);
    } catch (err) {
      const failed = err as { message: string; issues?: PayloadIssue[] };
      setError(failed.message);
      // The server checked the payload against the card's schema, so it can
      // say which field is wrong instead of only that something is.
      setIssues(failed.issues ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Send a message</h2>
      <p className="hint">
        Dispatched as you, not as an agent — the task records the caller as{" "}
        <code>user:…</code>. It may take minutes or hours, so this page polls.
      </p>

      {error ? (
        <div className="error">
          {error}
          {issues.length > 0 ? (
            <ul className="issues">
              {issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`}>
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <form className="inline-form" onSubmit={submit}>
        <label>
          Skill
          <select value={skillId} onChange={(e) => setSkillId(e.target.value)} required>
            {agent.skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Message
          <textarea
            value={body}
            required
            rows={5}
            placeholder={asJson ? '{ "pr": 9 }' : "Review the login fix"}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {schema ? (
          <details className="schema-hint">
            <summary>What {skillId} accepts</summary>
            <pre className="schema">{JSON.stringify(schema, null, 2)}</pre>
          </details>
        ) : (
          <p className="field-note">
            This skill declares no schema, so nothing here is checked before it
            is sent.
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={asJson}
            onChange={(e) => setAsJson(e.target.checked)}
          />
          Send as a JSON data part rather than text
        </label>
        <div className="form-actions">
          <button className="btn" type="submit" disabled={busy || !skillId}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>

      {task ? (
        <div className="task">
          <div className="row-head">
            <code>task {task.id}</code>
            <span className={`pill ${TERMINAL.includes(task.state) ? "" : "live"}`}>
              {task.state}
            </span>
          </div>
          <p className="row-sub">
            {task.skillId} → {task.targetAgentId} · deadline{" "}
            {new Date(task.deadlineAt).toLocaleString()}
          </p>
          {task.result ? (
            <pre className="schema">{JSON.stringify(task.result, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EditAgent({ agent, onChanged }: { agent: Agent; onChanged(a: Agent): void }) {
  const [endpointUrl, setEndpointUrl] = useState(agent.endpointUrl);
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [secret, setSecret] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Only what differs is sent. The server refuses an empty patch, and that
      // message is worth showing rather than pre-empting.
      const { agent: updated } = await updateAgent(agent.agentId, {
        ...(displayName.trim() && displayName.trim() !== agent.displayName
          ? { displayName: displayName.trim() }
          : {}),
        ...(endpointUrl.trim() && endpointUrl.trim() !== agent.endpointUrl
          ? { endpointUrl: endpointUrl.trim() }
          : {}),
        ...(clearCredential
          ? { credential: null }
          : secret.trim()
            ? { credential: { scheme: "bearer" as const, secret: secret.trim() } }
            : {}),
      });
      onChanged(updated);
      setSecret("");
      setClearCredential(false);
      setSaved(true);
    } catch (err) {
      setError((err as { message: string }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Change</h2>
      {error ? <div className="error">{error}</div> : null}
      {saved ? <p className="hint">Saved.</p> : null}
      <form className="inline-form" onSubmit={submit}>
        <label>
          Endpoint URL
          <input
            type="url"
            value={endpointUrl}
            required
            onChange={(e) => setEndpointUrl(e.target.value)}
          />
        </label>
        <p className="field-note">
          Changing this re-fetches the card: the agent has to be answering at the
          new address, or the old one is kept.
        </p>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Outbound bearer token
          <input
            type="password"
            value={secret}
            autoComplete="off"
            disabled={clearCredential}
            placeholder="leave blank to keep the stored one"
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={clearCredential}
            onChange={(e) => setClearCredential(e.target.checked)}
          />
          Remove the stored credential — the gateway will call this agent
          unauthenticated
        </label>
        <div className="form-actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function AgentDetail() {
  const { agentId = "" } = useParams();
  const location = useLocation() as { state?: { token?: string } };
  const navigate = useNavigate();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Registration navigates here with the token it issued; rotation replaces it.
  const [issued, setIssued] = useState<{ token: string; revoked?: number } | null>(
    location.state?.token ? { token: location.state.token } : null,
  );

  useEffect(() => {
    getAgent(agentId)
      .then((res) => setAgent(res.agent))
      .catch((err: { message: string }) => setError(err.message));
  }, [agentId]);

  async function rotate() {
    const ok = window.confirm(
      `Rotate the inbound token for ${agentId}?\n\n` +
        "Every token issued before now stops working immediately, including the " +
        "one this agent is running with.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await rotateAgentToken(agentId);
      setIssued({ token: res.token, revoked: res.revoked });
    } catch (err) {
      setError((err as { message: string }).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = window.confirm(
      `Remove ${agentId}?\n\n` +
        "Its tokens and stored credential go with it. Tasks it already ran stay " +
        "in the ledger.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await deleteAgent(agentId);
      navigate("/app/agents", { replace: true });
    } catch (err) {
      setError((err as { message: string }).message);
      setBusy(false);
    }
  }

  return (
    <Shell>
      {(me) => (
        <>
          <div className="page-head">
            <p className="crumb">
              <Link to="/app/agents">Agents</Link>
            </p>
            <h1>{agent?.displayName ?? agentId}</h1>
            {agent ? (
              <p>
                <code>{agent.agentId}</code> <HealthPill health={agent.health} /> ·{" "}
                {agent.endpointUrl}
              </p>
            ) : null}
          </div>

          {error ? <p className="error">{error}</p> : null}
          {!agent && !error ? <p className="center-note">Loading…</p> : null}

          {agent ? (
            <>
              {issued ? (
                <OneTimeToken
                  agentId={agent.agentId}
                  token={issued.token}
                  {...(issued.revoked === undefined ? {} : { revoked: issued.revoked })}
                  onDismiss={() => setIssued(null)}
                />
              ) : null}

              <div className="panel">
                <h2>Address</h2>
                <p className="hint">
                  Callers reach this agent through the gateway, never at its own
                  URL — that indirection is what the tenancy and the task ledger
                  hang off.
                </p>
                <code className="token-value">
                  {window.location.origin}/a2a/t/{me.tenant.slug}/agents/
                  {agent.agentId}
                </code>
                <p className="actions">
                  <button className="btn ghost" type="button" disabled={busy} onClick={rotate}>
                    Rotate token
                  </button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={remove}>
                    Remove agent
                  </button>
                </p>
              </div>

              <div className="grid-2">
                <Skills agent={agent} />
                <SendMessage agent={agent} />
                <EditAgent agent={agent} onChanged={setAgent} />
              </div>
            </>
          ) : null}
        </>
      )}
    </Shell>
  );
}
