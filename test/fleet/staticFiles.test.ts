import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFleetSiteServer, type FleetSiteStore } from "../../src/fleet/site/server.js";

/**
 * Serving the built SPA. The two things worth proving are that client-side
 * routes survive a reload, and that a crafted path cannot read outside the
 * build directory.
 */

let dir = "";
let server: Server;
let base = "";

const store = {
  async getTenantBySlug() {
    return null;
  },
  async resolveAgentToken() {
    return null;
  },
  async getAgent() {
    return null;
  },
  async listAgents() {
    return [];
  },
  async findAgentsBySkill() {
    return [];
  },
  async createTask() {
    throw new Error("unused");
  },
  async attachDownstream() {},
  async failTask() {},
  async getTaskByUpstreamId() {
    return null;
  },
  async appendTaskEvent() {},
  async getAgentCredential() {
    return null;
  },
  async resolveCallbackToken() {
    return null;
  },
  async recordDownstreamResult() {},
  async markNotified() {},
  async claimDueNotifications() {
    return [];
  },
  async recordNotifyFailure() {},
  async abandonNotification() {},
  async claimExpired() {
    return [];
  },
} as unknown as FleetSiteStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fleet-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  // A file the server must never reach, one level above the web root.
  writeFileSync(join(dir, "..", "fleet-web-secret.txt"), "do not serve me");

  server = createFleetSiteServer({
    store,
    publicBaseUrl: "http://127.0.0.1:1",
    webRoot: dir,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "fleet-web-secret.txt"), { force: true });
});

describe("serving the SPA", () => {
  it("serves the shell at the root", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("shell");
  });

  it("falls back to the shell for a client-side route", async () => {
    // Without this, reloading the page on /app is a 404.
    for (const path of ["/app", "/app/runs/12", "/login"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("shell");
    }
  });

  it("serves a real asset with its own content type", async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });
});

describe("caching", () => {
  it("marks fingerprinted assets immutable but never the shell", async () => {
    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    // The shell names the current bundle; caching it pins users to a stale
    // build after every deploy.
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("path traversal", () => {
  it("refuses to read outside the web root", async () => {
    // Encoded so the client does not normalise it away before it arrives.
    for (const path of [
      "/..%2ffleet-web-secret.txt",
      "/assets/..%2f..%2ffleet-web-secret.txt",
      "/%2e%2e%2ffleet-web-secret.txt",
    ]) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect(body, path).not.toContain("do not serve me");
      // A crafted path is not a client-side route, so it gets a refusal
      // rather than the shell.
      expect(res.status, path).toBe(404);
    }
  });
});

describe("the API surfaces keep their prefixes", () => {
  it("does not let static serving swallow /a2a or /api", async () => {
    // Both are unauthenticated here, so they must answer with their own
    // errors rather than the SPA shell.
    const a2a = await fetch(`${base}/a2a/t/acme/catalog`);
    expect(a2a.status).toBe(401);
    expect(a2a.headers.get("content-type")).toContain("application/json");

    const api = await fetch(`${base}/api/me`);
    expect(api.headers.get("content-type")).toContain("application/json");
  });

  it("still answers the health check", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
