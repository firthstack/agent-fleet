import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantRecord } from "../site/gatewayStore.js";
import { toFetchRequest, writeFetchResponse } from "./nodeBridge.js";

/**
 * The console API (docs/fleet-console.md §3, §5).
 *
 * Deliberately separate from `/a2a/*`. Letting one endpoint accept both a
 * session cookie and a bearer token is the easy move, and it costs two
 * things: the machine surface grows a CSRF face it never needed, and
 * `caller_agent_id` stops being one kind of thing. So the console
 * reimplements what it needs over the same stores.
 *
 * Every handler here resolves the tenant from the **session**. A tenant
 * identifier is never read from the path, the query or the body.
 */

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface ConsoleAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(args: { headers: Headers }): Promise<{ user: SessionUser } | null>;
  };
}

export interface ConsoleStore {
  tenantForUser(userId: string): Promise<TenantRecord | null>;
  ensureTenantForUser(user: SessionUser): Promise<TenantRecord>;
}

export interface ConsoleDeps {
  auth: ConsoleAuth;
  store: ConsoleStore;
  /** Origin used to rebuild an absolute URL for the fetch-style handler. */
  origin: string;
  maxBodyBytes?: number;
  logger?: { error(data: Record<string, unknown>, message?: string): void };
}

export interface Caller {
  user: SessionUser;
  tenant: TenantRecord;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

export function createConsoleHandler(deps: ConsoleDeps) {
  /** Session → user → tenant. The only way a console request gets a tenant. */
  async function resolveCaller(req: IncomingMessage): Promise<Caller | null> {
    const session = await deps.auth.api.getSession({ headers: headersOf(req) });
    if (!session?.user) return null;
    // A user created before the tenant hook existed, or whose hook failed,
    // would otherwise be signed in with nowhere to work.
    const tenant =
      (await deps.store.tenantForUser(session.user.id)) ??
      (await deps.store.ensureTenantForUser(session.user));
    return { user: session.user, tenant };
  }

  return async function handleConsole(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", deps.origin);
    if (!url.pathname.startsWith("/api/")) return false;

    try {
      // Better Auth owns its whole subtree: sign-up, sign-in, OAuth
      // callbacks, sign-out, session refresh.
      if (url.pathname.startsWith("/api/auth/")) {
        const response = await deps.auth.handler(
          await toFetchRequest(req, {
            origin: deps.origin,
            maxBodyBytes: deps.maxBodyBytes,
          }),
        );
        await writeFetchResponse(res, response);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        sendJson(res, 200, {
          user: {
            id: caller.user.id,
            email: caller.user.email,
            name: caller.user.name ?? null,
          },
          tenant: {
            slug: caller.tenant.slug,
            displayName: caller.tenant.displayName,
          },
        });
        return true;
      }

      sendJson(res, 404, { error: "not_found" });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.logger?.error(
        { path: url.pathname, method: req.method, error },
        "console request failed",
      );
      sendJson(res, 500, { error: "internal_error" });
      return true;
    }
  };
}
