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
