import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AsciiGlobe } from "../components/AsciiGlobe.tsx";
import { cameraAt, progressOf, stageFor } from "../landingCamera.ts";
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

/** The same run the copy describes, as the graph draws it. */
const TIMELINE = [
  { state: "developing", gap: "4.1h", slow: true, done: false },
  { state: "pr_opened", gap: "3s", slow: false, done: false },
  { state: "reviewing", gap: "3.2h", slow: true, done: false },
  { state: "requesting_merge", gap: "11s", slow: false, done: false },
  { state: "completed", gap: "", slow: false, done: true },
];

/** Loose formation, in percentages of the panel it sits in. */
const FORMATION = [
  { x: 20, y: 26 },
  { x: 48, y: 17 },
  { x: 76, y: 29 },
  { x: 32, y: 50 },
  { x: 63, y: 45 },
];

const TRACE = [
  { state: "developing", note: "dev.implement dispatched", gap: "+2s", slow: false },
  { state: "pr_opened", note: "PR #212", gap: "+4.1h", slow: true },
  { state: "reviewing", note: "review.pr dispatched", gap: "+3s", slow: false },
  { state: "completed", note: "merge requested", gap: "+11s", slow: false },
];

/** The sky is drawn from the same alphabet as the planet — round dots beside
 *  a character globe read as two different pictures. */
const STAR_GLYPHS = [".", "·", "·", "+", "*"];

/** Deterministic star field: the same sky on every load, and no work at
 *  render time beyond laying the spans out. */
function stars(seed: number, count: number) {
  const out: Array<{
    left: number;
    top: number;
    glyph: string;
    size: number;
    opacity: number;
    dur: number;
    delay: number;
  }> = [];
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < count; i += 1) {
    const left = next() % 100;
    const top = next() % 100;
    const n = next();
    const m = next();
    out.push({
      left,
      top,
      glyph: STAR_GLYPHS[n % STAR_GLYPHS.length],
      size: 9 + (m % 4),
      opacity: 0.16 + (n % 5) * 0.09,
      // Varied periods, or the whole sky pulses in step and reads as a
      // flicker in the page rather than as stars.
      dur: 3.5 + (m % 7) * 0.9,
      delay: (i % 11) * 0.7,
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
  const cam = cameraAt(progress);
  // The globe and everything riding it share one box, so a dot placed at 24%
  // stays at 24% of the globe whatever the camera is doing.
  const globe = {
    left: `${cam.x}vw`,
    top: `${cam.y}vh`,
    width: `${cam.size}vh`,
    height: `${cam.size}vh`,
  } as const;
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
                fontSize: s.size,
                ["--o" as string]: s.opacity,
                animationDuration: `${s.dur}s`,
                animationDelay: `${s.delay}s`,
              }}
            >
              {s.glyph}
            </span>
          ))}
        </div>
        <div className="starfield deep">
          {far.map((s, i) => (
            <span
              key={`f${i}`}
              style={{
                left: `${s.left}%`,
                top: `${s.top}%`,
                fontSize: s.size,
                ["--o" as string]: s.opacity,
                animationDuration: `${s.dur}s`,
                animationDelay: `${s.delay}s`,
              }}
            >
              {s.glyph}
            </span>
          ))}
        </div>

        {/* the hero's horizon, handed over to the globe as the camera pulls out */}
        <div className="horizon" style={globe} />
        <AsciiGlobe style={globe} stage={stage} />

        {/* 03 — the state graph laid out in time, in the freed right half */}
        <div className="stage s-trace">
          <div className="panel-right">
            <svg viewBox="0 0 460 420" className="stage-svg" aria-hidden="true">
              <defs>
                <marker id="tz" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="#3a434e" />
                </marker>
              </defs>
              {TIMELINE.map((step, i) => {
                const y = 40 + i * 82;
                const next = TIMELINE[i + 1];
                return (
                  <g key={step.state}>
                    {next ? (
                      <>
                        <path d={`M150 ${y + 16} V ${y + 66}`} stroke="#3a434e" strokeWidth="1.3" fill="none" markerEnd="url(#tz)" />
                        <text x="162" y={y + 46} fontFamily="IBM Plex Mono, monospace" fontSize="12" fill={step.slow ? "#d9ae66" : "#5f6b78"}>
                          {step.gap}
                        </text>
                      </>
                    ) : null}
                    <rect x="40" y={y} width="220" height="32" rx="6" fill={step.done ? "#0b1a14" : "#0f151c"} stroke={step.done ? "#1b6e4a" : "#3a434e"} />
                    <text x="150" y={y + 21} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="12.5" fill={step.done ? "#63c79a" : "#e3e8ee"}>
                      {step.state}
                    </text>
                  </g>
                );
              })}
              {/* the loop back — the reason this is a graph and not a list */}
              <path className="loop" d="M260 138 H340 V56 H260" stroke="#6fb3e0" strokeWidth="1.4" fill="none" markerEnd="url(#tz)" />
              <text x="348" y="100" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#6fb3e0">
                request_changes
              </text>
            </svg>
          </div>
        </div>

        {/* 04 — far out, the fleet in formation, drawn from the same
            alphabet as the planet it left */}
        <div className="stage s-fleet">
          <div className="panel-right">
            <div className="formation">
              {FORMATION.map((c, i) => (
                <span
                  key={`${c.x}-${c.y}`}
                  className="craft-glyph"
                  style={{ left: `${c.x}%`, top: `${c.y}%`, animationDelay: `${i * 0.8}s` }}
                >
                  &lt;=&gt;
                </span>
              ))}
              <span className="craft-glyph empty" style={{ left: "46%", top: "74%", animationDelay: "4s" }}>
                &lt;&middot;&gt;
              </span>
              <span className="formation-label" style={{ left: "46%", top: "84%" }}>
                + yours
              </span>
            </div>
          </div>
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

        <section className="stop centred hero">
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
