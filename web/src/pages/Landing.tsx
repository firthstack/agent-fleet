import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { progressOf, stageFor } from "../landingCamera.ts";
import "../landing.css";

/**
 * `/` — the public page.
 *
 * One pinned scene behind everything, and one camera move through it: the
 * horizon, then the whole globe with agents flickering, then the same dots
 * lighting in order, then a run laid out in time, then the fleet seen from
 * far out. The dots never move between stops — only the camera does — which
 * is what makes it read as a single shot rather than five pictures.
 *
 * The visual leads and the artifact closes: every stop ends on the concrete
 * thing (the curl, the definition, the timeline, the four hops), so a
 * developer gets proof and everyone else gets the picture first.
 */

/** Where the agents sit on the globe, in scene coordinates. Shared by every
 *  stage so a dot stays put while the camera pulls back. */
const AGENTS = [
  { dx: -190, dy: -46, name: "dev-agent" },
  { dx: -72, dy: -96, name: "review-agent" },
  { dx: 68, dy: -92, name: "deploy-agent" },
  { dx: 186, dy: -40, name: "ops-agent" },
  { dx: -8, dy: -124, name: "your-agent" },
];

/** The order a run walks them in — the `chase` on the compose stop. */
const ORDER = [0, 1, 2, 3, 4];

const HOPS = [
  { n: "1", what: "your workflow asks for a step", t: "message/send" },
  { n: "2", what: "Fleet routes it to the agent with that skill", t: "message/send" },
  {
    n: "3",
    what: "the agent works — minutes, or hours — then calls back",
    t: "/a2a/callbacks/…",
  },
  { n: "4", what: "the state graph moves on, and dispatches the next", t: "no connection held" },
];

const TRACE = [
  { state: "developing", note: "dev.implement dispatched", gap: "+2s", slow: false },
  { state: "pr_opened", note: "PR #212", gap: "+4.1h", slow: true },
  { state: "reviewing", note: "review.pr dispatched", gap: "+3s", slow: false },
  { state: "completed", note: "merge requested", gap: "+11s", slow: false },
];

/** Deterministic star field: the same sky on every load, and no work at
 *  render time beyond laying the spans out. */
function stars(seed: number, count: number) {
  const out: Array<{ left: number; top: number; size: number; opacity: number; delay: number }> =
    [];
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < count; i += 1) {
    const left = next() % 100;
    const top = next() % 100;
    const n = next();
    out.push({
      left,
      top,
      size: 1 + (n % 3) * 0.5,
      opacity: 0.14 + (n % 5) * 0.1,
      delay: (i % 9) * 0.5,
    });
  }
  return out;
}

/**
 * Scroll progress, 0 → 1 over the page, plus the stop it lands in.
 *
 * A rAF-throttled listener rather than a scroll-linked CSS timeline:
 * `animation-timeline` is still missing from enough browsers that the page
 * would simply not move for a share of visitors, and a landing page that
 * silently loses its one idea is worse than one that costs a listener.
 */
function useScrollCamera(stops: number) {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    const read = () => {
      frame.current = 0;
      setProgress(
        progressOf(
          window.scrollY,
          document.documentElement.scrollHeight,
          window.innerHeight,
        ),
      );
    };
    const onScroll = () => {
      if (frame.current) return;
      frame.current = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current) window.cancelAnimationFrame(frame.current);
    };
  }, []);

  const stage = useMemo(() => stageFor(progress, stops), [progress, stops]);

  return { progress, stage };
}

export function Landing() {
  const { progress, stage } = useScrollCamera(4);
  const near = useMemo(() => stars(11, 70), []);
  const far = useMemo(() => stars(97, 110), []);

  return (
    <div
      className="site"
      data-stage={stage}
      style={{ ["--p" as string]: progress.toFixed(4) }}
    >
      <div className="scene" aria-hidden="true">
        <div className="starfield">
          {near.map((s, i) => (
            <span
              key={`n${i}`}
              style={{
                left: `${s.left}%`,
                top: `${s.top}%`,
                width: s.size,
                height: s.size,
                opacity: s.opacity,
                animationDelay: `${s.delay}s`,
              }}
            />
          ))}
        </div>
        <div className="starfield deep">
          {far.map((s, i) => (
            <span
              key={`f${i}`}
              style={{
                left: `${s.left}%`,
                top: `${s.top}%`,
                width: s.size,
                height: s.size,
                opacity: s.opacity,
                animationDelay: `${s.delay}s`,
              }}
            />
          ))}
        </div>

        <div className="earth" />

        {/* 01 — the agents appear, each on its own rhythm */}
        <div className="stage s-connect">
          {AGENTS.map((a, i) => (
            <span
              key={a.name}
              className="agent flicker"
              style={{
                left: `calc(50% + ${a.dx}px)`,
                top: `calc(50% + ${a.dy}px)`,
                animationDelay: `${i * 0.7}s`,
              }}
            />
          ))}
        </div>

        {/* 02 — the same dots, lighting in a fixed order, links drawn between */}
        <div className="stage s-compose">
          <svg viewBox="0 0 1440 900" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            {ORDER.slice(0, -1).map((from, i) => {
              const a = AGENTS[from];
              const b = AGENTS[ORDER[i + 1]];
              return (
                <path
                  key={`l${i}`}
                  className="link"
                  d={`M${720 + a.dx} ${450 + a.dy} Q${720 + (a.dx + b.dx) / 2} ${
                    450 + Math.min(a.dy, b.dy) - 70
                  } ${720 + b.dx} ${450 + b.dy}`}
                  style={{ animationDelay: `${i}s` }}
                />
              );
            })}
          </svg>
          {ORDER.map((idx, i) => {
            const a = AGENTS[idx];
            return (
              <span
                key={`c${a.name}`}
                className="agent chase"
                style={{
                  left: `calc(50% + ${a.dx}px)`,
                  top: `calc(50% + ${a.dy}px)`,
                  animationDelay: `${i}s`,
                }}
              />
            );
          })}
        </div>

        {/* 03 — pulled back, one run laid out in time */}
        <div className="stage s-trace">
          <svg viewBox="0 0 1440 900" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <line x1="300" y1="300" x2="1140" y2="300" stroke="rgba(111,179,224,.28)" strokeWidth="1" />
            {["developing", "pr_opened", "reviewing", "requesting_merge", "completed"].map(
              (state, i) => {
                const gaps = ["+4.1h", "+3s", "+3.2h", "+11s", ""];
                const slow = gaps[i].endsWith("h");
                return (
                  <g key={state}>
                    <circle cx={300 + i * 210} cy="300" r="4.5" fill="#6fb3e0" />
                    <text
                      x={300 + i * 210}
                      y="282"
                      textAnchor="middle"
                      fontFamily="IBM Plex Mono, monospace"
                      fontSize="11"
                      fill="#94a0ae"
                    >
                      {state}
                    </text>
                    <text
                      x={300 + i * 210}
                      y="322"
                      textAnchor="middle"
                      fontFamily="IBM Plex Mono, monospace"
                      fontSize="10"
                      fill={slow ? "#d9ae66" : "#5f6b78"}
                    >
                      {gaps[i]}
                    </text>
                  </g>
                );
              },
            )}
          </svg>
        </div>

        {/* 04 — far out, the fleet in formation, one slot still dashed */}
        <div className="stage s-fleet">
          <svg viewBox="0 0 1440 900" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i} className="craft" style={{ animationDelay: `${i * 0.8}s` }}>
                <rect
                  x={430 + i * 115}
                  y={300 + (i % 2) * 26}
                  width="60"
                  height="24"
                  rx="4"
                  fill="#0b1016"
                  stroke="#6fb3e0"
                />
              </g>
            ))}
            <g className="craft" style={{ animationDelay: "4s" }}>
              <rect x="1005" y="326" width="60" height="24" rx="4" fill="#0b1016" stroke="#3a434e" strokeDasharray="3 2" />
            </g>
            <text x="1035" y="372" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="10" fill="#5f6b78">
              + yours
            </text>
          </svg>
        </div>
      </div>

      <div className="site-body">
        <nav className="site-nav">
          <span className="wordmark">Fleet</span>
          <span className="spacer" />
          <div className="links">
            <a href="https://github.com/firthstack/agent-fleet">Docs</a>
            <a href="https://a2a-protocol.org">Protocol</a>
            <Link to="/login">Sign in</Link>
            <Link to="/login" className="site-cta">
              Start a run
            </Link>
          </div>
        </nav>

        <section className="stop centred">
          <div>
            <p className="eyebrow quiet">multi-tenant A2A gateway</p>
            <div className="wordmark-hero">
              yourfleet<span className="run">.run</span>
            </div>
            <p className="blurb">
              Point Fleet at any agent that speaks A2A. It does the routing, the retries and
              the record.
            </p>
            <div className="four-words">
              <span>connect</span>
              <span>compose</span>
              <span>trace</span>
              <span>protocol</span>
            </div>
            <div className="site-actions">
              <Link to="/login" className="site-cta big">
                Start a run
              </Link>
              <a className="site-ghost" href="https://github.com/firthstack/agent-fleet">
                Read the docs
              </a>
            </div>
            <p className="scroll-cue">scroll ↓</p>
          </div>
        </section>

        <section className="stop">
          <div>
            <p className="eyebrow">01 — connect</p>
            <h2>Every agent you have, in one place.</h2>
            <p className="blurb">
              Paste a URL. Fleet fetches the card, records the skills it advertises, and hands
              back one inbound token. Any language, any host.
            </p>
            <div className="artifact">
              <div className="artifact-head">connect an agent</div>
              <div className="shell">
                <div>
                  <span className="prompt">$</span> curl -X POST yourfleet.run/api/agents \
                </div>
                <div className="arg">&nbsp;&nbsp;-d '{`{"endpointUrl":"https://my-agent.dev"}`}'</div>
                <div className="ok">✓ card fetched · 3 skills registered</div>
              </div>
            </div>
          </div>
        </section>

        <section className="stop">
          <div>
            <p className="eyebrow">02 — compose</p>
            <h2>Then give them an order to work in.</h2>
            <p className="blurb">
              A state graph Fleet owns, not code buried in one agent. Review asks for changes
              and the work goes back round — the shape a straight pipeline cannot express.
            </p>
            <div className="artifact">
              <div className="artifact-head">develop-review-merge · v3</div>
              <pre>
                <code>{`"reviewing": {
  "next": [
    { "when": "result.verdict == 'approved'",
      "goto": "requesting_merge" },
    { "when": "result.verdict == 'request_changes'",
      "goto": "revising" }
  ]
}`}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="stop">
          <div>
            <p className="eyebrow">03 — trace</p>
            <h2>Watch the whole fleet at once.</h2>
            <p className="blurb">
              Every state a run entered and the gap before the next. When one is stuck, the
              page says which step and for how long.
            </p>
            <div className="artifact wide">
              {TRACE.map((s) => (
                <div className="artifact-row trace" key={s.state}>
                  <span className="k" style={{ color: s.state === "completed" ? "#63c79a" : "#e3e8ee" }}>
                    {s.state}
                  </span>
                  <span className="v">{s.note}</span>
                  <span className="t" style={{ color: s.slow ? "#d9ae66" : undefined }}>
                    {s.gap}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="stop">
          <div>
            <p className="eyebrow">04 — protocol</p>
            <h2>Standard A2A. Nothing to install.</h2>
            <p className="blurb">
              Both ends of every hop speak standard{" "}
              <a href="https://a2a-protocol.org">A2A</a>. Fleet is an A2A server facing callers
              and an A2A client facing your agents — so you keep whatever library you already
              use.
            </p>
            <div className="artifact wide">
              {HOPS.map((h) => (
                <div className="artifact-row hop" key={h.n}>
                  <span className="k" style={{ color: "#6fb3e0" }}>
                    {h.n}
                  </span>
                  <span className="v" style={{ color: "#e3e8ee" }}>
                    {h.what}
                  </span>
                  <span className="t">{h.t}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="stop centred">
          <div>
            <h2>Point it at one agent.</h2>
            <p className="blurb">
              A URL, a card, and a token shown once. The second agent is where it starts paying
              off.
            </p>
            <div className="site-actions">
              <Link to="/login" className="site-cta big">
                Start a run
              </Link>
              <a className="site-ghost" href="https://github.com/firthstack/agent-fleet">
                Read the docs
              </a>
            </div>
          </div>
        </section>

        <footer className="site-foot">
          <div>
            <span>yourfleet.run</span>
            <span className="spacer" />
            <a href="https://github.com/firthstack/agent-fleet">github</a>
            <a href="https://a2a-protocol.org">A2A protocol</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
