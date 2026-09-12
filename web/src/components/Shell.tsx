import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getMe, type Me } from "../api.ts";
import { signOut } from "../authClient.ts";

/**
 * The signed-in frame: every `/app/*` page hangs off this one. It owns the
 * session check, so a page never renders against a caller the server would
 * answer 401 to.
 */
export function Shell({ children }: { children: (me: Me) => ReactNode }) {
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
        <nav className="nav">
          <Link to="/app/agents">Agents</Link>
          <Link to="/app/workflows">Workflows</Link>
          <Link to="/app/runs">Runs</Link>
        </nav>
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

      <div className="wrap">{children(me)}</div>
    </>
  );
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: "healthy",
  unreachable: "unreachable",
  stale: "stale",
  unknown: "unknown",
};

export function HealthPill({ health }: { health: string }) {
  return <span className={`pill ${health}`}>{HEALTH_LABEL[health] ?? health}</span>;
}

/** The one-time token box. Registration and rotation both end here, and it
 *  says the same thing in both cases because the rule is the same (§9.4). */
export function OneTimeToken({
  agentId,
  token,
  revoked,
  onDismiss,
}: {
  agentId: string;
  token: string;
  revoked?: number;
  onDismiss(): void;
}) {
  return (
    <div className="token">
      <p className="token-head">
        Inbound token for <code>{agentId}</code>
      </p>
      <code className="token-value">{token}</code>
      <p className="token-note">
        Shown once — only its hash is stored. Put it in the agent's config now; if
        it is lost, rotate to get another.
        {revoked
          ? ` ${revoked} earlier token${revoked > 1 ? "s" : ""} stopped working just now.`
          : ""}
      </p>
      <button className="btn ghost" type="button" onClick={onDismiss}>
        Done
      </button>
    </div>
  );
}
