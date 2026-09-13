import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { AsciiGlobe } from "../components/AsciiGlobe.tsx";
import { cameraAt, progressOf, stageFor } from "../landingCamera.ts";
import { PRODUCT_NAME } from "../product.ts";
import { BOX, LOOP, TIMELINE, VIEWBOX, boxY, loopLabelY, loopPath } from "../traceGraph.ts";
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

/** Loose formation, in percentages of the panel it sits in. */
const FORMATION = [
  { x: 20, y: 26 },
  { x: 48, y: 17 },
  { x: 76, y: 29 },
  { x: 32, y: 50 },
  { x: 63, y: 45 },
];

/**
 * The four words in the hero, and the stops they name.
 *
 * They read as a contents page, so they behave like one. The `id` is the word
 * itself — a reader who lands on `#trace` from someone else's link gets the
 * same place the word goes to.
 */
const WORDS = ["connect", "compose", "trace", "protocol"] as const;

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

/**
 * Jump to a stop, gently.
 *
 * The camera is driven by scroll position, so a native fragment jump
 * teleports the globe: the whole move the page exists to show happens in one
 * frame, unseen. Scrolling smoothly plays it instead — except for anyone who
 * has asked for less movement, who gets the jump.
 */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  // No target means something was renamed; let the browser fail its own way
  // rather than swallowing the click.
  if (!target) return;
  event.preventDefault();
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  // scrollIntoView moves the page but not the caret. Without this a keyboard
  // user is scrolled to the stop and then tabs on from the top of the page.
  target.focus({ preventScroll: true });
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
            <svg viewBox={`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`} className="stage-svg" aria-hidden="true">
              <defs>
                <marker id="tz" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="#39424d" />
                </marker>
                {/* the loop keeps its own head: a grey arrow on a blue dashed
                    line reads as the line stopping short of the box */}
                <marker id="tzl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="rgba(111,179,224,.7)" />
                </marker>
              </defs>
              {TIMELINE.map((step, i) => {
                const y = boxY(i);
                const next = TIMELINE[i + 1];
                return (
                  <g key={step.state}>
                    {next ? (
                      <>
                        <path d={`M${BOX.x + BOX.w / 2} ${y + BOX.h} V ${y + BOX.pitch - 14}`} stroke="#39424d" strokeWidth="1.2" fill="none" markerEnd="url(#tz)" />
                        <text x={BOX.x + BOX.w / 2 + 12} y={y + BOX.h + 24} fontFamily="IBM Plex Mono, monospace" fontSize="12" fill={step.slow ? "#b3903f" : "#57616d"}>
                          {step.gap}
                        </text>
                      </>
                    ) : null}
                    <rect
                      x={BOX.x}
                      y={y}
                      width={BOX.w}
                      height={BOX.h}
                      rx="6"
                      fill={step.done ? "rgba(14,32,25,.7)" : "rgba(15,21,28,.7)"}
                      stroke={step.done ? "#2c6349" : "#39424d"}
                    />
                    <text x={BOX.x + BOX.w / 2} y={y + 22} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="12.5" fill={step.done ? "#6aa98c" : "#9aa9b8"}>
                      {step.state}
                    </text>
                  </g>
                );
              })}
              {/* the loop back — `request_changes` is the review's verdict, so
                  it leaves reviewing and returns to developing */}
              <path className="loop" d={loopPath()} stroke="rgba(111,179,224,.7)" strokeWidth="1.2" fill="none" markerEnd="url(#tzl)" />
              <text x={BOX.lane + 8} y={loopLabelY()} fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="rgba(111,179,224,.68)">
                {LOOP.label}
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
              <span className="craft-glyph vacant" style={{ left: "46%", top: "72%", animationDelay: "4s" }}>
                &lt;&middot;&gt;
              </span>
              <span className="formation-label" style={{ left: "46%", top: "87%" }}>
                + yours
              </span>
            </div>
          </div>
        </div>

      </div>

      <div className="site-body">
        <nav className="site-nav">
          <span className="wordmark">{PRODUCT_NAME}</span>
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
              {WORDS.map((word) => (
                <a key={word} href={`#${word}`} onClick={(e) => jumpTo(e, word)}>
                  {word}
                </a>
              ))}
            </div>
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

        <section className="stop" id="connect" tabIndex={-1}>
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

        <section className="stop" id="compose" tabIndex={-1}>
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

        <section className="stop" id="trace" tabIndex={-1}>
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

        <section className="stop" id="protocol" tabIndex={-1}>
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
