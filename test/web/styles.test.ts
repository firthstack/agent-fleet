import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The header nav (`Shell.tsx`) renders three `<Link>`s as siblings with no
// text between the JSX tags, so nothing but a CSS rule on `.nav` keeps them
// from rendering flush against each other. See agent-fleet#10.
describe("header nav spacing", () => {
  const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

  it("gives .nav a non-zero gap between its links", () => {
    const match = css.match(/\.nav\s*\{([^}]*)\}/);
    expect(match, ".nav rule should exist in styles.css").not.toBeNull();
    const body = match![1];

    const display = body.match(/display:\s*([\w-]+)/)?.[1];
    expect(display).toBe("flex");

    const gap = body.match(/gap:\s*([\d.]+)px/)?.[1];
    expect(gap, ".nav should declare a gap").toBeDefined();
    expect(Number(gap)).toBeGreaterThan(0);
  });
});

// The definition editor and the state diagram both scroll their own
// contents. Left unstyled, both get the browser's default scrollbar — a
// flat white box in every theme, light or dark. See agent-fleet#6.
describe("code editor and diagram scrollbars", () => {
  const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

  it("themes the scrollbar with the page's own palette, not a hardcoded color", () => {
    const rule = css.match(/textarea\.code,\s*\n\.diagram\s*\{([^}]*)\}/);
    expect(rule, "a shared scrollbar rule for textarea.code and .diagram should exist").not.toBeNull();
    const body = rule![1];

    expect(body).toMatch(/scrollbar-color:\s*var\(--rule-strong\)\s+var\(--surface-2\)/);
    expect(body).not.toMatch(/#fff|white/i);
  });

  it("styles the webkit scrollbar thumb and track for both elements", () => {
    expect(css).toMatch(/textarea\.code::-webkit-scrollbar-thumb,\s*\n\.diagram::-webkit-scrollbar-thumb\s*\{[^}]*var\(--rule-strong\)/);
    expect(css).toMatch(/textarea\.code::-webkit-scrollbar-track,\s*\n\.diagram::-webkit-scrollbar-track\s*\{[^}]*var\(--surface-2\)/);
  });
});

// The landing page is a night sky in both themes. `styles.css` flips its
// tokens with `prefers-color-scheme`, so anything the space scene reads from
// them would invert on a light-mode visitor's machine — the ground would go
// white behind the stars.
describe("the landing page owns its palette", () => {
  const css = readFileSync(new URL("../../web/src/landing.css", import.meta.url), "utf8");

  it("declares its own ground and ink rather than inheriting the console's", () => {
    const site = css.match(/\.site\s*\{([^}]*)\}/);
    expect(site, ".site rule should exist in landing.css").not.toBeNull();
    const body = site![1];
    expect(body).toMatch(/--ground:\s*#[0-9a-f]{3,8}/i);
    expect(body).toMatch(/--ink:\s*#[0-9a-f]{3,8}/i);
    expect(body).toMatch(/--accent:\s*#[0-9a-f]{3,8}/i);
  });

  it("reads no themed token from the console stylesheet", () => {
    // Fonts are theme-independent and shared on purpose; colour is not.
    const themed = css.match(/var\(--(surface|rule|muted-token|bg|live|ok|warn|bad)[\w-]*\)/g);
    expect(themed, `landing.css should not read console colour tokens: ${themed}`).toBeNull();
  });
});

// The scene is painted behind the whole page. Without this it would swallow
// every click and hover on the content sitting above it.
describe("the landing scene stays out of the way", () => {
  const css = readFileSync(new URL("../../web/src/landing.css", import.meta.url), "utf8");

  it("never takes pointer events", () => {
    const scene = css.match(/\.scene\s*\{([^}]*)\}/);
    expect(scene, ".scene rule should exist").not.toBeNull();
    expect(scene![1]).toMatch(/pointer-events:\s*none/);
  });

  it("holds the camera still for anyone who asked for less motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(block).toMatch(/animation:\s*none/);
  });
});

// The point of /app/runs is scanning twenty rows for the one that is stuck.
// Cards would fit five on a screen; the row has to stay a grid.
describe("the run table stays scannable", () => {
  const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

  it("lays each run out as a grid row, not a stacked card", () => {
    const row = css.match(/\.run-row\s*\{([^}]*)\}/);
    expect(row, ".run-row rule should exist in styles.css").not.toBeNull();
    const body = row![1];
    expect(body).toMatch(/display:\s*grid/);
    const cols = body.match(/grid-template-columns:\s*([^;]+)/)?.[1] ?? "";
    // id · status · state · source · note · age
    expect(cols.split(/\s+(?![^(]*\))/).length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the state pill starting at the same x on every row", () => {
    const pill = css.match(/\.run-row \.pill\s*\{([^}]*)\}/);
    expect(pill, ".run-row .pill rule should exist").not.toBeNull();
    expect(pill![1]).toMatch(/justify-self:\s*start/);
  });
});
