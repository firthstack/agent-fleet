import { Link } from "react-router-dom";

const DEFINITION = `{
  "workflow": "develop-review-merge",
  "states": {
    "reviewing": {
      "call": { "skill": "review.pr", "payload": { "prUrl": "{{vars.prUrl}}" } },
      "next": [
        { "when": "result.verdict == 'approved'",        "goto": "requesting_merge" },
        { "when": "result.verdict == 'request_changes'", "goto": "changes_requested" },
        { "when": "result.verdict == 'comment'",         "escalate": "review_comment" },
        { "fail": "review_failed" }
      ]
    }
  },
  "limits": { "maxIterations": 7 }
}`;

/** The four hops a single step actually takes, which is the whole pitch. */
const CHAIN = [
  { n: "1", what: "your workflow asks for a step", t: "message/send" },
  { n: "2", what: "the gateway dispatches it to the agent that has that skill", t: "message/send" },
  { n: "3", what: "the agent works — minutes, or hours — then calls back", t: "/a2a/callbacks/…" },
  { n: "4", what: "the state machine moves on, and dispatches the next step", t: "no connection held" },
];

export function Landing() {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          agent<span className="dot">·</span>fleet
        </Link>
        <span className="spacer" />
        <Link to="/login" className="btn ghost">
          Sign in
        </Link>
      </header>

      <div className="wrap">
        <section className="hero">
          <p className="eyebrow">A2A gateway</p>
          <h1>Your agents, composed into a fleet.</h1>
          <p>
            Register any agent that speaks A2A. Compose them into workflows that the
            gateway owns — not code buried inside one agent. Then watch every run, step
            by step, and see exactly where one is stuck.
          </p>
          <div className="cta">
            <Link to="/login" className="btn">
              Get started
            </Link>
            <a className="btn ghost" href="https://a2a-protocol.org">
              What is A2A?
            </a>
          </div>
        </section>

        <section className="section">
          <div className="points">
            <div className="point">
              <h3>No SDK to adopt</h3>
              <p>
                Both ends speak standard A2A. Your agent publishes a card, accepts{" "}
                <code>message/send</code>, and calls back when it is done. Use whatever
                library you like, in whatever language.
              </p>
            </div>
            <div className="point">
              <h3>Workflows are definitions</h3>
              <p>
                A state machine the gateway holds, with judgment-driven loops — review
                asks for changes, the work goes back for revision, and round again,
                bounded by a limit you set.
              </p>
            </div>
            <div className="point">
              <h3>Built for hours, not seconds</h3>
              <p>
                No connection is held while an agent works. Delivery, backoff retries and
                deadline sweeps are the gateway's job, so a workflow never has to
                implement them.
              </p>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>One step, four hops</h2>
          <p>
            A step is one row in a ledger. Nothing lives in memory, so a restart loses
            nothing and a replayed callback changes nothing.
          </p>
          <div className="chain">
            {CHAIN.map((row) => (
              <div className="chain-row" key={row.n}>
                <span className="n">{row.n}</span>
                <span>{row.what}</span>
                <span className="t">{row.t}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <h2>This is the whole thing</h2>
          <p>
            One state out of the worked example. Publish it, start a run, and the gateway
            does the rest — including refusing to publish a definition whose transitions
            could strand a run hours in.
          </p>
          <pre>
            <code>{DEFINITION}</code>
          </pre>
        </section>

        <footer className="site">
          agent-fleet — a multi-tenant A2A gateway with a workflow composition layer.
        </footer>
      </div>
    </>
  );
}
