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

/**
 * Names a deployer has nothing to set, each with the reason it is exempt. Kept
 * as a list rather than a pattern so that adding one is a decision somebody
 * made on purpose.
 */
const EXEMPT: Record<string, string> = {
  NODE_ENV: "set by the runtime, not by a deployer",
  PORT: "supplied by the host platform; FLEET_PORT overrides it",
  FLEET_MODE: "one legal value ('site'), which is also the default",
};

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
      // Both access patterns. Most of this codebase takes `env` as an
      // injected parameter (`env: NodeJS.ProcessEnv = process.env`) and reads
      // `env.FLEET_PORT` off it, so matching only `process.env.X` would miss
      // the majority of the variables that actually configure the gateway.
      for (const match of source.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]*)/g)) {
        referenced.add(match[1]);
      }
    }

    const example = readFileSync(".env.example", "utf8");
    const documented = new Set(
      [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );

    const missing = [...referenced]
      .filter((name) => !documented.has(name) && !(name in EXEMPT))
      .sort();
    expect(missing).toEqual([]);
  });

  it("keeps no exemption for a variable the code stopped reading", () => {
    // An exemption list nobody prunes is how a real gap hides behind a stale
    // entry, so the list has to justify itself against the source each run.
    const source = sourceFiles("src")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const stale = Object.keys(EXEMPT).filter(
      (name) => !new RegExp(`(?:process\\.env|\\benv)\\.${name}\\b`).test(source),
    );
    expect(stale).toEqual([]);
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
