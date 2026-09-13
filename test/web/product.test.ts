import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../web/src/product";

/**
 * The name was written out in four places and two of them had already gone
 * stale: the landing page said Fleet, the app shell and the login card said
 * `agent·fleet`, which is what the repository is called, not the product.
 * Someone signing up met a different product on either side of the button.
 *
 * Three of those places now read one constant. The fourth is the server,
 * which cannot import from the web bundle — so it is checked as text instead
 * of coupled to it.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("the product's name", () => {
  const SURFACES = [
    "web/src/components/Shell.tsx",
    "web/src/pages/Login.tsx",
    "web/src/pages/Landing.tsx",
  ];

  it.each(SURFACES)("is read from one constant in %s", (path) => {
    const src = read(path);
    expect(src).toContain('from "../product.ts"');
    expect(src).toContain("{PRODUCT_NAME}");
  });

  it.each(SURFACES)("is not written out by hand in %s", (path) => {
    // `agent-fleet` is still the repository's name, so the GitHub links and
    // the issue references that use it are correct and stay. What must not
    // come back is the product calling itself that to a user.
    const prose = read(path)
      .replace(/https?:\/\/\S+/g, "")
      .replace(/agent-fleet#\d+/g, "");
    expect(prose).not.toMatch(/agent[·.\-\s]fleet/i);
  });

  it("is what the browser tab says", () => {
    expect(read("web/index.html")).toContain(`<title>${PRODUCT_NAME}</title>`);
  });

  it("is what the server signs its mail with", () => {
    // Better Auth puts `appName` in front of users; a server calling itself
    // something else is the same split, one layer down.
    const appName = read("src/auth.ts").match(/appName:\s*"([^"]+)"/);
    expect(appName?.[1]).toBe(PRODUCT_NAME);
  });
});
