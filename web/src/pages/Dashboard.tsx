import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getMe, type Me } from "../api.ts";
import { signOut } from "../authClient.ts";

export function Dashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((err: { status?: number; message: string }) => {
        if (err.status === 401) navigate("/login");
        else setError(err.message);
      });
  }, [navigate]);

  if (error) return <p className="center-note">{error}</p>;
  if (!me) return <p className="center-note">Loading…</p>;

  return (
    <>
      <header className="topbar">
        <Link to="/app" className="brand">
          agent<span className="dot">·</span>fleet
        </Link>
        <span className="spacer" />
        <span className="who">
          <b>{me.user.email}</b> · tenant <code>{me.tenant.slug}</code>
        </span>
        <button
          className="btn ghost"
          onClick={async () => {
            await signOut();
            navigate("/");
          }}
        >
          Sign out
        </button>
      </header>

      <div className="wrap">
        <div className="page-head">
          <h1>Dashboard</h1>
          <p>
            Nothing is connected yet. An agent has to be reachable from the gateway
            before it can be registered.
          </p>
        </div>

        <div className="grid-2">
          <div className="panel">
            <h2>Agents</h2>
            <p className="hint">
              Any A2A server: it publishes a card, accepts a message, and calls back
              when the work is done.
            </p>
            <div className="empty">
              <p className="lead">No agents registered.</p>
              <p className="lead">
                <span className="soon">next</span> Registering one from here ships with
                agent onboarding.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2>Workflows</h2>
            <p className="hint">
              A state machine this gateway owns, composing the skills your agents
              advertise.
            </p>
            <div className="empty">
              <p className="lead">No workflows published.</p>
              <p className="lead">
                <span className="soon">next</span> The editor validates a definition
                before it can be published.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2>Runs</h2>
            <p className="hint">
              Every step of every run, with how long it has sat where it is.
            </p>
            <div className="empty">
              <p className="lead">No runs yet.</p>
              <p className="lead">
                <span className="soon">next</span> A run appears here the moment a
                workflow is started.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
