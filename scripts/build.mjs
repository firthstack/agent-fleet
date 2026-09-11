// Low-memory alternative to `tsc -p tsconfig.build.json`.
//
// Why: the type-check version of tsc needs 1.5–2 GB just to resolve the
// transitive type graph (Octokit + Slack Bolt + the agent SDK are huge). On a
// 1 GB EC2 host that OOMs. esbuild strips types without running full type
// inference and finishes in < 50 MB.
//
// We still want a real type check — that runs via `npm run typecheck` on your
// laptop / in CI, NOT on the deploy host. This build only emits JS.

import { build } from "esbuild";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC = "src";
const OUT = "dist";

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = await walk(SRC);
if (files.length === 0) {
  console.error("No .ts files found under src/");
  process.exit(1);
}

const t0 = Date.now();
await build({
  entryPoints: files,
  outdir: OUT,
  outbase: SRC,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  // No --bundle: we want one-to-one transpile so relative imports
  // stay intact and node_modules deps stay external.
  logLevel: "info",
});

// Sanity check — the original tsc setup emitted dist/index.js; keep that.
const entry = join(OUT, "index.js");
try {
  await stat(entry);
} catch {
  console.error(`Expected ${entry} after build — not found.`);
  process.exit(1);
}

console.log(
  `built ${files.length} files → ${OUT}/ in ${Date.now() - t0}ms (entry: ${relative(process.cwd(), entry)})`,
);
