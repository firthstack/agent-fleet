import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createA2AClient, type A2AClient } from "./a2aClient.js";
import { createCallbackHandler, createNotifier, createSweeper } from "./callbacks.js";
import {
  createGateway,
  type GatewayResponse,
  type GatewayStorePort,
  type GatewayWorkflowsPort,
  type GatewayWorkflowStarter,
} from "./gateway.js";
import type { CallbackStorePort } from "./callbacks.js";
import type { AgentCredential } from "./a2aClient.js";
import { createHealthSweeper, hashToken, type HealthSweepStorePort } from "./registration.js";
import type { GatewayAgentRecord } from "./gatewayStore.js";
import type { SecretBox } from "./secretBox.js";
import { createStaticHandler } from "./staticFiles.js";
import type { IncomingMessage as NodeRequest, ServerResponse as NodeResponse } from "node:http";

export interface FleetSiteLogger {
  info(data: Record<string, unknown>, message?: string): void;
  warn?(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}

/** Everything the site needs from storage, as a structural type. */
export type FleetSiteStore = GatewayStorePort &
  CallbackStorePort & {
    getAgentCredential(
      tenantId: number,
      agentId: string,
    ): Promise<AgentCredential | null>;
  };

export interface FleetSiteOptions {
  store: FleetSiteStore;
  /**
   * The console. Handles `/api/*` (session-authenticated) and returns true
   * when it took the request. Omit it and those paths 404.
   */
  console?(req: NodeRequest, res: NodeResponse): Promise<boolean>;
  /** Directory holding the built SPA. Omit it and only the API is served. */
  webRoot?: string;
  /** The composition layer. Omit it and the workflow routes answer 404. */
  workflows?: GatewayWorkflowsPort;
  workflowStarter?: GatewayWorkflowStarter;
  /** Public origin of this site; every URL handed out is built from it. */
  publicBaseUrl: string;
  secretBox?: SecretBox;
  a2aClient?: A2AClient;
  logger?: FleetSiteLogger;
  now?(): Date;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const [scheme, ...rest] = auth.split(" ");
  if (scheme.toLowerCase() !== "bearer") return null;
  return rest.join(" ").trim() || null;
}

/**
 * Read the body with a hard ceiling. Without one, an unauthenticated POST to
 * the callback endpoint can stream until the process runs out of memory.
 */
export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, response: GatewayResponse): void {
  const payload = JSON.stringify(response.body ?? {});
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function createFleetSiteHandler(opts: FleetSiteOptions) {
  const client = opts.a2aClient ?? createA2AClient();
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const serveStatic = opts.webRoot
    ? createStaticHandler({ root: opts.webRoot })
    : undefined;

  const gateway = createGateway({
    store: opts.store,
    workflows: opts.workflows,
    workflowStarter: opts.workflowStarter,
    client,
    credentials: (tenantId, agentId) =>
      opts.store.getAgentCredential(tenantId, agentId),
    publicBaseUrl: opts.publicBaseUrl,
    newUpstreamTaskId: () => randomBytes(16).toString("hex"),
    newCallbackToken: () => randomBytes(32).toString("base64url"),
    hashToken,
    now: opts.now,
  });

  const callbacks = createCallbackHandler({ store: opts.store, hashToken });

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fleet.local");
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/healthz") {
        send(res, { status: 200, body: { ok: true } });
        return;
      }

      // The console owns /api/* entirely — a different authentication scheme
      // and a different threat model from the machine surface below.
      if (opts.console && url.pathname.startsWith("/api/")) {
        if (await opts.console(req, res)) return;
      }

      // The standalone run viewer used to sit here. `/app/runs` replaces it
      // (docs/fleet-console.md §4): it reads the same runs out of a session
      // instead of asking the user to paste an *agent* token into a browser,
      // which was only ever a stand-in for an identity we did not have yet.

      // Static last among the GET surfaces: /a2a and /api claim their prefixes
      // above, and anything else that is not a real file falls back to the
      // SPA shell so a client-side route survives a reload.
      if (
        serveStatic &&
        !url.pathname.startsWith("/a2a/") &&
        !url.pathname.startsWith("/api/") &&
        (await serveStatic(req, res, url.pathname))
      ) {
        return;
      }

      let body: unknown;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const raw = await readBody(req, maxBody);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            send(res, { status: 400, body: { error: "invalid_json" } });
            return;
          }
        }
      }

      // Callbacks first: they authenticate by path token, not by bearer, so
      // they must not fall into the gateway's authenticate() path.
      const callbackResult = await callbacks({
        method,
        path: url.pathname,
        body,
      });
      if (callbackResult) {
        send(res, callbackResult);
        return;
      }

      send(
        res,
        await gateway({
          method,
          path: url.pathname,
          bearerToken: bearerToken(req),
          body,
        }),
      );
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        send(res, { status: 413, body: { error: "payload_too_large" } });
        return;
      }
      const error = err instanceof Error ? err.message : String(err);
      opts.logger?.error(
        { path: url.pathname, method, error },
        "fleet site request failed",
      );
      send(res, { status: 500, body: { error: "internal_error" } });
    }
  };
}

export function createFleetSiteServer(opts: FleetSiteOptions): Server {
  const handle = createFleetSiteHandler(opts);
  return createServer((req, res) => {
    void handle(req, res);
  });
}

export interface FleetWorkerHandle {
  stop(): void;
  /** Exposed so tests can drive a tick without waiting on a timer. */
  runOnce(): Promise<void>;
  /** Present only when `healthCheck` was configured; drives one sweep tick. */
  runHealthCheckOnce?(): Promise<{ checked: number; unreachable: number }>;
}

/**
 * The background half of step ④ plus the timeout sweep (docs §8). Without
 * these two loops a delivery that fails once is never retried and a silent
 * downstream strands its caller forever.
 */
export function startFleetWorkers(opts: {
  store: CallbackStorePort;
  /** Advances composition-layer runs whose step just finished. */
  workflowDriver?: { runOnce(): Promise<{ advanced: number; retried: number; abandoned: number }> };
  /**
   * Drives the registration health sweep (docs §5 step 5). Omit it and agent
   * health is only ever written once, at registration — `refresh()` exists
   * but nothing calls it, so a dead agent reads "healthy" forever.
   */
  healthCheck?: {
    store: HealthSweepStorePort;
    refresh(
      agent: GatewayAgentRecord,
    ): Promise<{ health: "healthy" | "unreachable"; changed: boolean }>;
    /** Separate from `intervalMs`: re-fetching every agent's card is far more
     *  expensive than a DB sweep, so it defaults to a much slower cadence. */
    intervalMs?: number;
  };
  logger?: FleetSiteLogger;
  intervalMs?: number;
  now?(): Date;
}): FleetWorkerHandle {
  const notify = createNotifier({
    store: opts.store,
    now: opts.now,
    logger: opts.logger,
  });
  const sweep = createSweeper({ store: opts.store, now: opts.now });

  let stopped = false;

  async function runOnce(): Promise<void> {
    // Sweep first, so a step that just timed out is handled in this same
    // tick rather than waiting for the next one.
    const swept = await sweep();
    // Then the composition layer: a finished workflow step advances its run,
    // which may dispatch the next step immediately.
    const driven = (await opts.workflowDriver?.runOnce()) ?? {
      advanced: 0,
      retried: 0,
      abandoned: 0,
    };
    const sent = await notify();
    if (
      swept.timedOut > 0 ||
      sent.delivered > 0 ||
      sent.retried > 0 ||
      driven.advanced > 0 ||
      driven.abandoned > 0
    ) {
      opts.logger?.info(
        { ...swept, ...sent, workflow: driven },
        "fleet gateway worker tick",
      );
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    runOnce().catch((err) => {
      opts.logger?.error(
        { error: err instanceof Error ? err.message : String(err) },
        "fleet gateway worker tick failed",
      );
    });
  }, opts.intervalMs ?? 15_000);
  // Never hold the process open just for the sweep timer.
  timer.unref?.();

  let healthTimer: NodeJS.Timeout | undefined;
  let runHealthCheckOnce: (() => Promise<{ checked: number; unreachable: number }>) | undefined;
  if (opts.healthCheck) {
    const healthCheck = opts.healthCheck;
    const sweepHealth = createHealthSweeper({
      store: healthCheck.store,
      refresh: healthCheck.refresh,
    });
    runHealthCheckOnce = async () => {
      const result = await sweepHealth();
      if (result.unreachable > 0) {
        opts.logger?.info(result, "fleet gateway health sweep found unreachable agents");
      }
      return result;
    };
    healthTimer = setInterval(() => {
      if (stopped) return;
      runHealthCheckOnce!().catch((err) => {
        opts.logger?.error(
          { error: err instanceof Error ? err.message : String(err) },
          "fleet gateway health sweep failed",
        );
      });
    }, healthCheck.intervalMs ?? 5 * 60_000);
    // Never hold the process open just for the health sweep timer.
    healthTimer.unref?.();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (healthTimer) clearInterval(healthTimer);
    },
    runOnce,
    ...(runHealthCheckOnce ? { runHealthCheckOnce } : {}),
  };
}

export function fleetPublicBaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.FLEET_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "FLEET_PUBLIC_BASE_URL is required — every gateway and callback URL " +
        "handed to an agent is built from it (e.g. https://fleet.example.com)",
    );
  }
  // A wrong value here is silently corrosive: agents would be told to call
  // back to an address that does not reach us.
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`FLEET_PUBLIC_BASE_URL is not a valid URL: ${raw}`);
  }
}
