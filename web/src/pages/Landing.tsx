import { useEffect, useMemo, useRef, type MouseEvent, type RefObject } from "react";
import { Link } from "react-router-dom";
import { AsciiGlobe } from "../components/AsciiGlobe.tsx";
import { cameraAt } from "../landingCamera.ts";
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

/** The last camera stop: independent agents visibly coordinated by Fleet. */
const FLEET_NODES = [
  { x: 102, y: 90, id: "builder_01", skill: "BUILD", route: "M102 90 C156 90 194 142 246 187" },
  { x: 310, y: 58, id: "reviewer_02", skill: "REVIEW", route: "M310 58 V175" },
  { x: 518, y: 90, id: "tester_03", skill: "TEST", route: "M518 90 C464 90 426 142 374 187" },
  { x: 126, y: 326, id: "deployer_04", skill: "DEPLOY", route: "M126 326 C180 326 214 278 250 237" },
  { x: 494, y: 326, id: "your_agent", skill: "ANY A2A SKILL", route: "M494 326 C440 326 406 278 370 237", open: true },
];

/**
 * The four words in the hero, and the stops they name.
 *
 * They read as a contents page, so they behave like one. The `id` is the word
 * itself — a reader who lands on `#trace` from someone else's link gets the
 * same place the word goes to.
 */
const JOURNEY = [
  { id: "connect", label: "Agents", action: "connect" },
  { id: "compose", label: "Workflow", action: "compose" },
  { id: "trace", label: "Live run", action: "trace" },
  { id: "protocol", label: "Outcome", action: "deliver" },
] as const;

const TRACE = [
  { state: "dev_agent", note: "completed · PR #212", gap: "4m 12s", tone: "done" },
  { state: "review_agent", note: "waiting for callback", gap: "18m 42s", tone: "blocked" },
  { state: "merge_agent", note: "queued", gap: "—", tone: "idle" },
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
 * Scroll-driven camera that stays out of React's render loop.
 *
 * A rAF-throttled listener rather than a scroll-linked CSS timeline:
 * `animation-timeline` is still missing from enough browsers that the page
 * would simply not move for a share of visitors, and a landing page that
 * silently loses its one idea is worse than one that costs a listener.
 */
function useScrollCamera(root: RefObject<HTMLDivElement | null>) {
  const frame = useRef(0);

  useEffect(() => {
    const site = root.current;
    if (!site) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let current = 0;
    let target = current;
    let lastStage = -1;
    let anchors: Array<{ y: number; progress: number }> = [];
    let stageTops: number[] = [];
    let proofTop = Number.POSITIVE_INFINITY;

    const measure = () => {
      const ids = ["connect", "compose", "trace", "protocol"];
      const progress = [0.26, 0.5, 0.76, 1];
      const lead = window.innerHeight * 0.24;
      stageTops = ids.map((id) => {
        const el = document.getElementById(id);
        return el ? el.getBoundingClientRect().top + window.scrollY : 0;
      });
      const proof = document.getElementById("product-proof");
      proofTop = proof
        ? proof.getBoundingClientRect().top + window.scrollY
        : Number.POSITIVE_INFINITY;
      anchors = [
        { y: 0, progress: 0 },
        ...stageTops.map((y, i) => ({ y: Math.max(1, y - lead), progress: progress[i] })),
      ];
    };

    const narrativeProgress = (scrollY: number) => {
      if (anchors.length < 2) return 0;
      let i = 0;
      while (i < anchors.length - 2 && scrollY > anchors[i + 1].y) i += 1;
      const a = anchors[i];
      const b = anchors[i + 1];
      const t = Math.min(1, Math.max(0, (scrollY - a.y) / Math.max(1, b.y - a.y)));
      return a.progress + (b.progress - a.progress) * t;
    };

    const activeStage = (scrollY: number) => {
      const probe = scrollY + window.innerHeight * 0.42;
      if (probe >= proofTop) return 5;
      let stage = 0;
      stageTops.forEach((top, i) => {
        if (probe >= top) stage = i + 1;
      });
      return stage;
    };

    const paint = (progress: number) => {
      const cam = cameraAt(progress);
      const stage = activeStage(window.scrollY);
      site.style.setProperty("--p", progress.toFixed(4));
      site.style.setProperty("--camera-x", `${cam.x.toFixed(3)}vw`);
      site.style.setProperty("--camera-y", `${cam.y.toFixed(3)}vh`);
      site.style.setProperty("--camera-scale", (cam.size / 100).toFixed(4));
      site.style.setProperty("--space-x", `${(-progress * 3).toFixed(3)}vw`);
      site.style.setProperty("--space-y", `${(-progress * 5).toFixed(3)}vh`);
      site.style.setProperty("--grid-y", `${(progress * 5).toFixed(3)}vh`);
      site.style.setProperty("--deep-y", `${(-progress * 2.5).toFixed(3)}vh`);
      site.style.setProperty("--deep-opacity", (0.25 + progress * 0.75).toFixed(3));
      site.style.setProperty("--grid-opacity", (0.04 + progress * 0.11).toFixed(3));
      // Cross-fade the close horizon into the ASCII globe instead of changing
      // both at a stage boundary. The latter was the most visible "snap" in
      // the original camera move.
      const reveal = Math.min(1, Math.max(0, (progress - 0.075) / 0.09));
      site.style.setProperty("--globe-reveal", reveal.toFixed(3));
      site.style.setProperty("--horizon-reveal", (1 - reveal).toFixed(3));
      if (stage !== lastStage) {
        site.dataset.stage = String(stage);
        lastStage = stage;
      }
    };

    const animate = () => {
      // A short ease-out absorbs the coarse jumps produced by trackpads and
      // wheel events, but stops quickly enough to keep the scene attached to
      // the reader's hand.
      current += (target - current) * 0.16;
      if (Math.abs(target - current) < 0.00015) current = target;
      paint(current);
      if (current !== target) frame.current = window.requestAnimationFrame(animate);
      else frame.current = 0;
    };

    const read = () => {
      target = narrativeProgress(window.scrollY);
      if (still) {
        current = target;
        paint(current);
      } else if (!frame.current) {
        frame.current = window.requestAnimationFrame(animate);
      }
    };

    measure();
    current = narrativeProgress(window.scrollY);
    target = current;
    paint(current);
    window.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => {
      measure();
      read();
    };
    window.addEventListener("resize", onResize);

    const sections = Array.from(site.querySelectorAll<HTMLElement>(".stop"));
    const reveal = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) (entry.target as HTMLElement).dataset.revealed = "true";
        });
      },
      { rootMargin: "0px 0px -12%", threshold: 0.12 },
    );
    sections.forEach((section) => reveal.observe(section));
    site.dataset.motionReady = "true";

    function onScroll() {
      read();
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      reveal.disconnect();
      if (frame.current) window.cancelAnimationFrame(frame.current);
    };
  }, [root]);
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
  target.focus({ preventScroll: true });
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useScrollCamera(root);
  const near = useMemo(() => stars(11, 48), []);
  const far = useMemo(() => stars(97, 72), []);

  return (
    <div className="site" data-stage="0" ref={root}>
      <div className="scene" aria-hidden="true">
        <div className="space-haze" />
        <div className="space-grid" />
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
        <div className="horizon" />
        <AsciiGlobe />

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

        {/* 04 — far out, the product model in one glance: heterogeneous
            agents around Fleet, with messages flowing through one workflow. */}
        <div className="stage s-fleet">
          <div className="panel-right">
            <svg
              className="fleet-topology"
              viewBox="0 0 620 410"
              role="img"
              aria-labelledby="fleet-topology-title fleet-topology-description"
            >
              <title id="fleet-topology-title">A fleet of agents coordinated by Fleet</title>
              <desc id="fleet-topology-description">
                Builder, reviewer, tester, deployer, and your own A2A agent exchange work through the Fleet orchestrator.
              </desc>
              <defs>
                <marker id="fleet-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 8 4 0 8Z" />
                </marker>
              </defs>

              <g className="topology-routes" aria-hidden="true">
                {FLEET_NODES.map((node, index) => (
                  <path
                    key={node.id}
                    className="topology-route"
                    d={node.route}
                    style={{ animationDelay: `${index * -0.7}s` }}
                  />
                ))}
              </g>

              <g className="topology-hub">
                <circle className="topology-orbit outer" cx="310" cy="210" r="75" />
                <circle className="topology-orbit inner" cx="310" cy="210" r="61" />
                <rect x="242" y="175" width="136" height="70" rx="12" />
                <circle className="topology-live" cx="261" cy="194" r="3.5" />
                <text className="topology-hub-name" x="310" y="207" textAnchor="middle">FLEET</text>
                <text className="topology-hub-role" x="310" y="226" textAnchor="middle">ORCHESTRATOR</text>
              </g>

              {FLEET_NODES.map((node) => (
                <g
                  key={node.id}
                  className={`topology-agent${node.open ? " open" : ""}`}
                  transform={`translate(${node.x} ${node.y})`}
                >
                  <rect x="-68" y="-28" width="136" height="56" rx="9" />
                  <circle cx="-49" cy="-8" r="3.2" />
                  <text className="topology-agent-id" x="-39" y="-4">{node.id}</text>
                  <text className="topology-agent-skill" x="-49" y="15">{node.skill}</text>
                </g>
              ))}

              <text className="topology-caption" x="310" y="394" textAnchor="middle">
                <tspan>5 AGENTS</tspan><tspan> · 1 OBSERVABLE WORKFLOW</tspan>
              </text>
            </svg>
          </div>
        </div>

      </div>

      <div className="site-body">
        <nav className="site-nav">
          <span className="wordmark"><i />{PRODUCT_NAME}</span>
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
          <div className="stop-copy">
            <p className="eyebrow quiet brand-lockup">
              <span className="live-dot" />
              <strong>Fleet</strong>
              <span>yourfleet.run</span>
            </p>
            <h1 className="wordmark-hero">
              <span className="hero-line">Turn independent agents</span>
              <span className="hero-line">into one <span className="run">observable fleet.</span></span>
            </h1>
            <p className="blurb">
              Connect any A2A agent, compose real workflows, and see exactly where
              the work is moving—or stuck.
            </p>
            <div className="four-words">
              {JOURNEY.map((step, index) => (
                <a key={step.id} href={`#${step.id}`} onClick={(e) => jumpTo(e, step.id)}>
                  <small>0{index + 1} · {step.action}</small>
                  <span>{step.label}</span>
                </a>
              ))}
            </div>
            <div className="site-actions">
              <Link to="/login" className="site-cta big">
                Start building
              </Link>
              <a className="site-ghost" href="#product-proof" onClick={(e) => jumpTo(e, "product-proof")}>
                View a live run
              </a>
            </div>
            <div className="hero-signal" aria-label="Product capabilities">
              <span><b>◎</b> A2A native</span>
              <span><b>↳</b> long-running</span>
              <span><b>◇</b> fully traced</span>
            </div>
            <a className="scroll-cue" href="#connect" onClick={(e) => jumpTo(e, "connect")}>
              <span>scroll to explore</span><i />
            </a>
          </div>
        </section>

        <section className="stop" id="connect" tabIndex={-1}>
          <div className="stop-copy">
            <p className="eyebrow">01 — connect</p>
            <h2>Bring every agent into range.</h2>
            <p className="blurb">
              Give Fleet an endpoint. It discovers the agent card, indexes every skill,
              and brings the agent online—whatever language or host it uses.
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
          <div className="stop-copy">
            <p className="eyebrow">02 — compose</p>
            <h2>Design the mission, not the plumbing.</h2>
            <p className="blurb">
              Put the workflow in a state graph instead of burying it inside one agent.
              Branch, retry, loop, or wait for a human without rebuilding the fleet.
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
          <div className="stop-copy">
            <p className="eyebrow">03 — trace</p>
            <h2>Watch work move. See where it stops.</h2>
            <p className="blurb">
              Follow every handoff across the fleet. When a run stalls, Fleet names the
              agent, the step, and exactly how long it has been waiting.
            </p>
            <div className="artifact wide">
              {TRACE.map((s) => (
                <div className={`artifact-row trace ${s.tone}`} key={s.state}>
                  <span className="k"><i />{s.state}</span>
                  <span className="v">{s.note}</span>
                  <span className="t">{s.gap}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="stop" id="protocol" tabIndex={-1}>
          <div className="stop-copy">
            <p className="eyebrow">04 — protocol</p>
            <h2>Keep your stack. Fleet speaks A2A.</h2>
            <p className="blurb">
              Both ends of every hop speak standard{" "}
              <a href="https://a2a-protocol.org">A2A</a>. Fleet faces callers as a server and your agents
              as a client, so nothing in your existing agent stack has to change.
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

        <section className="stop centred product-proof" id="product-proof" tabIndex={-1}>
          <div className="stop-copy">
            <p className="eyebrow">mission control</p>
            <h2>One view for the whole run.</h2>
            <p className="blurb">
              The workflow, every participating agent, and the current blocker—together,
              while there is still time to act.
            </p>
            <div className="fleet-console" aria-label="Example Fleet run dashboard">
              <header className="console-bar">
                <div className="console-brand"><i /> Fleet</div>
                <div className="console-crumb"><span>runs</span><b>/</b> ship-auth-hardening</div>
                <span className="console-live"><i /> running</span>
              </header>
              <div className="console-body">
                <aside className="run-summary">
                  <p className="console-label">RUN</p>
                  <h3>ship-auth-hardening</h3>
                  <p className="console-run-id">run_7f31c8</p>
                  <div className="run-metrics">
                    <div><strong>3</strong><span>agents</span></div>
                    <div><strong>24m</strong><span>elapsed</span></div>
                    <div><strong>1</strong><span>blocked</span></div>
                  </div>
                  <p className="console-label agent-label">AGENTS</p>
                  <div className="console-agents">
                    <span><i className="done" /> dev_agent <small>done</small></span>
                    <span><i className="blocked" /> review_agent <small>waiting</small></span>
                    <span><i /> merge_agent <small>queued</small></span>
                  </div>
                </aside>
                <div className="run-canvas">
                  <div className="canvas-head">
                    <div><span className="console-label">WORKFLOW</span><strong>develop-review-merge · v3</strong></div>
                    <span className="canvas-clock">00:24:18</span>
                  </div>
                  <div className="run-path">
                    <div className="run-node done">
                      <span className="node-number">01</span>
                      <div><strong>Develop</strong><small>dev_agent · completed in 4m 12s</small></div>
                      <span className="node-state">done</span>
                    </div>
                    <i className="path-line done" />
                    <div className="run-node blocked">
                      <span className="node-number">02</span>
                      <div><strong>Review</strong><small>review_agent · waiting for callback</small></div>
                      <span className="node-state">18m 42s</span>
                    </div>
                    <div className="blocker-note">
                      <span>BLOCKED</span>
                      <p>Callback not received from review_agent.</p>
                      <small>Last activity 18 minutes ago · retry 1 of 3</small>
                    </div>
                    <i className="path-line" />
                    <div className="run-node queued">
                      <span className="node-number">03</span>
                      <div><strong>Merge</strong><small>merge_agent · waiting upstream</small></div>
                      <span className="node-state">queued</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="stop centred">
          <div className="stop-copy final-callout">
            <p className="eyebrow">ready when your agents are</p>
            <h2>Your agents already know how to work.</h2>
            <p className="blurb">
              Fleet helps them work together—and shows you the whole mission while they do.
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
