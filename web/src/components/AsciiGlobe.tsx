import { useEffect, useRef, type CSSProperties } from "react";
import { GRID, placeOnGlobe, renderGlobe } from "../globe.ts";

/**
 * The turning earth, and everything standing on it.
 *
 * Globe, agents and the links between them all live here because they all
 * depend on one number — the spin — and splitting them would mean either
 * three animation loops or passing the angle through React state sixty times
 * a second. One loop writes to the DOM directly instead: two `<pre>` bodies,
 * five dot positions, four path shapes. Nothing here re-renders.
 */

const { cols: COLS, rows: ROWS } = GRID;
/** Degrees per second. Slow enough to read as a planet, not a carousel. */
const SPIN_RATE = 5;

/**
 * Where the fleet is. Real cities, because "an agent in São Paulo and one in
 * Singapore" is the actual shape of the problem this product solves — and a
 * dot has to be somewhere.
 */
/**
 * Where the fleet is, in workflow order.
 *
 * Spread over about 140° of longitude, not the 260° the first pass used: a
 * hemisphere is all that faces the viewer at once, so a chain wider than that
 * can never be seen whole, and the compose stop showed one or two hops of a
 * five-step run. This span fits on one face — and a fleet that follows the
 * working day west to east is the honest version of the picture anyway.
 */
export const FLEET = [
  { name: "dev-agent", lon: 0, lat: 51 }, // London
  { name: "ops-agent", lon: 31, lat: 30 }, // Cairo
  { name: "review-agent", lon: 78, lat: 13 }, // Bangalore
  { name: "deploy-agent", lon: 104, lat: 1 }, // Singapore
  { name: "your-agent", lon: 140, lat: 36 }, // Tokyo
];

/** One second per hop, so the relay's period is the length of the chain. */
const HOP_SECONDS = 1;

export function AsciiGlobe({ style, stage }: { style: CSSProperties; stage: number }) {
  const land = useRef<HTMLPreElement>(null);
  const sea = useRef<HTMLPreElement>(null);
  const dots = useRef<Array<HTMLSpanElement | null>>([]);
  const links = useRef<Array<SVGPathElement | null>>([]);
  const frame = useRef(0);

  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let spin = 20;
    let last = performance.now();

    const paint = () => {
      const { land: l, sea: s } = renderGlobe(COLS, ROWS, spin);
      if (land.current) land.current.textContent = l;
      if (sea.current) sea.current.textContent = s;

      const placed = FLEET.map((a) => placeOnGlobe(a.lon, a.lat, spin, COLS, ROWS));
      placed.forEach((p, i) => {
        const el = dots.current[i];
        if (!el) return;
        el.style.left = `${p.x * 100}%`;
        el.style.top = `${p.y * 100}%`;
        // Fade rather than hide: a dot that blinks out at the limb draws more
        // attention than the turn it is meant to be part of.
        el.style.opacity = p.visible ? "" : "0";
      });

      links.current.forEach((el, i) => {
        if (!el) return;
        const a = placed[i];
        const b = placed[i + 1];
        if (!a?.visible || !b?.visible) {
          el.style.opacity = "0";
          return;
        }
        el.style.opacity = "";
        const [ax, ay] = [a.x * 100, a.y * 100];
        const [bx, by] = [b.x * 100, b.y * 100];
        // Bow the chord away from the centre so the hop reads as going over
        // the surface rather than through the planet.
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const out = 1 + 22 / Math.max(12, Math.hypot(mx - 50, my - 50));
        el.setAttribute(
          "d",
          `M${ax} ${ay} Q${50 + (mx - 50) * out} ${50 + (my - 50) * out} ${bx} ${by}`,
        );
      });
    };

    paint();
    if (still) return;

    const tick = (now: number) => {
      spin = (spin + ((now - last) / 1000) * SPIN_RATE) % 360;
      last = now;
      paint();
      frame.current = window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame.current);
  }, []);

  /*
   * The cell. Size and line height are one measurement, not two settings:
   * ROWS lines at line-height 1 have to come to exactly the box's height, or
   * the sphere stops being round. Inline because a stylesheet rule for bare
   * `pre` out-ranks a class, and one that set line-height stretched this into
   * a standing ellipse.
   */
  const cell = {
    fontSize: `calc(${style.height ?? "0px"} / ${ROWS})`,
    lineHeight: 1,
  } as const;

  return (
    <div className="globe" style={style} aria-hidden="true">
      <pre ref={sea} className="globe-layer sea" style={cell} />
      <pre ref={land} className="globe-layer land" style={cell} />

      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="globe-links">
        {FLEET.slice(0, -1).map((a, i) => (
          <path
            key={a.name}
            ref={(el) => {
              links.current[i] = el;
            }}
            className="link"
            style={{
              animationDuration: `1.6s, ${FLEET.length * HOP_SECONDS}s`,
              animationDelay: `${-i * 0.4}s, ${i * HOP_SECONDS}s`,
            }}
          />
        ))}
      </svg>

      <div className="fleet-dots">
        {FLEET.map((a, i) => (
          <span
            key={a.name}
            ref={(el) => {
              dots.current[i] = el;
            }}
            className={`agent ${stage === 2 ? "chase" : "flicker"}`}
            style={
              stage === 2
                ? {
                    animationDuration: `${FLEET.length * HOP_SECONDS}s`,
                    animationDelay: `${i * HOP_SECONDS}s`,
                  }
                : { animationDelay: `${i * 0.7}s` }
            }
          />
        ))}
      </div>
    </div>
  );
}
