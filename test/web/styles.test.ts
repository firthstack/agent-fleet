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
