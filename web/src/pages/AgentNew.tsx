import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerAgent, type RegisterAgentInput } from "../api.ts";
import { Shell } from "../components/Shell.tsx";

/**
 * `/app/agents/new` (docs/fleet-console.md §4).
 *
 * Registering is one POST, but what happens behind it is a server-side fetch
 * of the agent's card — so most of what this form has to report is the
 * agent's failure, not its own: unreachable, no card, a card with no skills.
 *
 * Two credentials point in opposite directions and must not blur together:
 *
 *   the field below   what the gateway presents when it calls the agent
 *   the token after   what the agent presents when it calls back
 *
 * Only the second is generated here. Getting the first wrong does not fail
 * registration — it fails the first dispatch, hours later.
 */
export function AgentNew() {
  const [agentId, setAgentId] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: RegisterAgentInput = {
        agentId: agentId.trim(),
        endpointUrl: endpointUrl.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(secret.trim()
          ? { credential: { scheme: "bearer" as const, secret: secret.trim() } }
          : {}),
      };
      const { agent, token } = await registerAgent(input);
      // The token rides in router state rather than the URL: it is shown once
      // and a URL is the one place that would keep a copy.
      navigate(`/app/agents/${encodeURIComponent(agent.agentId)}`, {
        state: { token },
        replace: true,
      });
    } catch (err) {
      setError((err as { message: string }).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      {() => (
        <>
          <div className="page-head">
            <h1>Connect an agent</h1>
            <p>
              The card is fetched from <code>/.well-known/agent-card.json</code>{" "}
              under the endpoint before anything is saved, so the agent has to be
              up.
            </p>
          </div>

          <div className="panel">
            {error ? <div className="error">{error}</div> : null}
            <form className="inline-form" onSubmit={submit}>
              <label>
                Agent ID
                <input
                  value={agentId}
                  required
                  placeholder="review-agent"
                  pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
                  title="3-64 chars: lowercase letters, digits and hyphens"
                  onChange={(e) => setAgentId(e.target.value)}
                />
              </label>
              <label>
                Endpoint URL
                <input
                  type="url"
                  value={endpointUrl}
                  required
                  placeholder="https://review.example.com"
                  onChange={(e) => setEndpointUrl(e.target.value)}
                />
              </label>
              <label>
                Display name <span className="opt">optional</span>
                <input
                  value={displayName}
                  placeholder="taken from the card"
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
              <label>
                Outbound bearer token <span className="opt">optional</span>
                <input
                  type="password"
                  value={secret}
                  autoComplete="off"
                  placeholder="what the gateway presents to this agent"
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <p className="field-note">
                Leave this blank only if the agent accepts unauthenticated calls.
                The card fetch does not carry it, so an agent that wants a bearer
                still registers cleanly and then rejects the first dispatch.
              </p>
              <div className="form-actions">
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Fetching the card…" : "Connect"}
                </button>
                <Link className="btn ghost" to="/app/agents">
                  Cancel
                </Link>
              </div>
            </form>
          </div>
        </>
      )}
    </Shell>
  );
}
