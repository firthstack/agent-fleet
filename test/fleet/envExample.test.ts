import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The drift guard (docs/fleet-console.md §10).
 *
 * `.env.example` is the only place a deployer learns what this process reads.
 * A variable added in code and not here is invisible until something fails in
 * production — and the console's additions (`BETTER_AUTH_SECRET`,
 * `FLEET_TRUSTED_ORIGINS`) are exactly the kind whose absence shows up as a
 * subtly broken session rather than a crash.
 */

/** Set by the platform, not by a deployer, so not ours to document. */
const AMBIENT = new Set(["NODE_ENV"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe(".env.example", () => {
  it("documents every variable the gateway reads", () => {
    const referenced = new Set<string>();
    for (const file of sourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        if (!AMBIENT.has(match[1])) referenced.add(match[1]);
      }
    }

    const example = readFileSync(".env.example", "utf8");
    const documented = new Set(
      [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );

    const missing = [...referenced].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("carries no secret values, only the names", () => {
    const example = readFileSync(".env.example", "utf8");
    for (const [, name, value] of example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      // A real credential in a committed file is the failure this catches;
      // a placeholder host or a default path is not one.
      if (/SECRET|KEY|TOKEN|PASSWORD/.test(name)) {
        expect(value.trim(), `${name} must be left blank`).toBe("");
      }
    }
  });
});
