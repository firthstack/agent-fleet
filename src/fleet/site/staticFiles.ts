import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves the built SPA (docs/fleet-console.md §10).
 *
 * Two things this has to get right. Paths are resolved and then checked to be
 * inside the root, so `../` in a request cannot walk out of it. And anything
 * that is not a real file falls back to `index.html`, because the client owns
 * routing — without that, a reload on `/app` is a 404.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticOptions {
  root: string;
  /** Fingerprinted assets are immutable; index.html must never be. */
  immutablePrefix?: string;
}

/**
 * `escape` and `missing` are kept apart on purpose: a path that is merely
 * absent is a client-side route and gets the shell, but one that tried to walk
 * out of the root is not a route at all, and answering it with a 200 would
 * tell the caller their traversal was accepted.
 */
type Lookup = { kind: "file"; path: string } | { kind: "missing" } | { kind: "escape" };

async function fileIn(root: string, pathname: string): Promise<Lookup> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "escape" };
  }
  if (decoded.includes("\0")) return { kind: "escape" };
  // Reject `..` before normalising. `normalize` would collapse a leading one
  // against the root and leave an in-root path that simply does not exist,
  // which the SPA fallback would then answer with a 200 — the traversal is
  // harmless by then, but the caller should be told no, not handed the shell.
  if (decoded.split("/").includes("..")) return { kind: "escape" };

  const candidate = resolve(join(root, normalize(decoded)));
  // `normalize` alone is not enough — the result still has to be inside root.
  if (candidate !== root && !candidate.startsWith(root + sep)) return { kind: "escape" };
  try {
    const info = await stat(candidate);
    return info.isFile() ? { kind: "file", path: candidate } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}

export function createStaticHandler(opts: StaticOptions) {
  const root = resolve(opts.root);
  const immutable = opts.immutablePrefix ?? "/assets/";

  return async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const direct = await fileIn(root, pathname);
    if (direct.kind === "escape") return false;

    // A missing asset must not be answered with the shell: the browser asked
    // for a script and would get HTML, which fails with a MIME error that
    // says nothing about the real problem (a stale or wrong bundle name).
    if (direct.kind === "missing" && pathname.startsWith(immutable)) return false;

    const shell = direct.kind === "file" ? null : await fileIn(root, "index.html");
    const file = direct.kind === "file" ? direct.path : shell?.kind === "file" ? shell.path : null;
    if (!file) return false;

    res.statusCode = 200;
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.setHeader(
      "cache-control",
      direct.kind === "file" && pathname.startsWith(immutable)
        ? "public, max-age=31536000, immutable"
        : // The shell names the current asset bundle, so caching it would
          // pin users to a stale build after every deploy.
          "no-cache",
    );

    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    await new Promise<void>((resolveWrite, reject) => {
      createReadStream(file).on("error", reject).pipe(res).on("finish", resolveWrite);
    });
    return true;
  };
}
