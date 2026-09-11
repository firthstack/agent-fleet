import { describe, expect, it, vi } from "vitest";
import { createA2AServer, type A2AServerRequest } from "../../src/fleet/runtime/a2aServer.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

const CARD: A2AAgentCard = {
  name: "Codex Review Agent",
  description: "Reviews PRs.",
  version: "1.0.0",
  skills: [{ id: "review.pr", name: "Review", description: "Review a PR." }],
};

const TOKEN = "gateway-secret";
const authenticate = (req: A2AServerRequest) => req.bearerToken === TOKEN;

function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: { role: "user", parts: [{ kind: "data", data: { prUrl: "https://pr/1" } }] },
      configuration: {
        pushNotificationConfig: {
          url: "https://fleet.example.com/a2a/callbacks/tok",
          token: "tok",
        },
      },
      ...overrides,
    },
  };
}

function post(body: unknown, token: string | null = TOKEN): A2AServerRequest {
  return { method: "POST", path: "/", bearerToken: token, body };
}

describe("A2A agent server", () => {
  it("serves the agent card without authentication", async () => {
    const server = createA2AServer({ card: CARD, skills: {}, authenticate });
    const res = await server.handle({
      method: "GET",
      path: "/.well-known/agent-card.json",
      bearerToken: null,
    });
    // Discovery must work before any credential is exchanged.
    expect(res.status).toBe(200);
    expect((res.body as A2AAgentCard).name).toBe("Codex Review Agent");
  });

  it("rejects work from an unauthenticated caller", async () => {
    const ran = vi.fn();
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ran() },
      authenticate,
    });
    const res = await server.handle(post(sendBody(), "wrong"));
    expect(res.status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });

  it("accepts the task and returns before the work finishes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = createA2AServer({
      card: CARD,
      skills: {
        "review.pr": async () => {
          await gate;
          return { ok: true };
        },
      },
      authenticate,
      fetchImpl: (async () => ({ ok: true }) as Response) as unknown as typeof fetch,
    });

    const res = await server.handle(post(sendBody()));
    const result = (res.body as { result: { id: string; status: { state: string } } }).result;
    // Holding the connection for an hours-long job is what this design set
    // out to avoid, so the reply must come back while the work is pending.
    expect(result.status.state).toBe("submitted");
    expect(server.store.get(result.id)?.state).not.toBe("completed");

    release?.();
    await server.drain();
    expect(server.store.get(result.id)?.state).toBe("completed");
  });

  it("posts the completion to the caller's callback with its token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ({ verdict: "approved" }) },
      authenticate,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    await server.handle(post(sendBody()));
    await server.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://fleet.example.com/a2a/callbacks/tok");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      status: { state: "completed" },
      result: { verdict: "approved" },
    });
  });

  it("reports a handler failure instead of going silent", async () => {
    let reported: Record<string, unknown> = {};
    const server = createA2AServer({
      card: CARD,
      skills: {
        "review.pr": async () => {
          throw new Error("Codex failed");
        },
      },
      authenticate,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        reported = JSON.parse(init.body as string);
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    const res = await server.handle(post(sendBody()));
    await server.drain();

    const id = (res.body as { result: { id: string } }).result.id;
    expect(server.store.get(id)?.state).toBe("failed");
    expect(reported).toMatchObject({ status: { state: "failed" }, error: "Codex failed" });
  });

  it("retries the completion callback, then gives up", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ({ ok: true }) },
      authenticate,
      notifyAttempts: 3,
      sleep,
      fetchImpl: (async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await server.handle(post(sendBody()));
    await server.drain();

    expect(attempts).toBe(3);
    // Two waits for three attempts — never sleeping after the last one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("never starts work whose deadline has already passed", async () => {
    const ran = vi.fn();
    let reported: Record<string, unknown> = {};
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ran() },
      authenticate,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        reported = JSON.parse(init.body as string);
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    const res = await server.handle(
      post(sendBody({ metadata: { deadlineAt: new Date(Date.now() - 1000).toISOString() } })),
    );
    await server.drain();

    // Starting an hours-long Codex run for a result nobody is waiting for any
    // more would burn real budget.
    expect(ran).not.toHaveBeenCalled();
    const id = (res.body as { result: { id: string } }).result.id;
    expect(server.store.get(id)?.state).toBe("failed");
    expect(reported).toMatchObject({ status: { state: "failed" } });
  });

  it("aborts a running handler when the deadline arrives", async () => {
    let aborted = false;
    const server = createA2AServer({
      card: CARD,
      skills: {
        "review.pr": async ({ signal }) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true;
              resolve();
              return;
            }
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          });
          return { ok: false };
        },
      },
      authenticate,
      fetchImpl: (async () => ({ ok: true }) as Response) as unknown as typeof fetch,
    });

    await server.handle(
      post(sendBody({ metadata: { deadlineAt: new Date(Date.now() + 30).toISOString() } })),
    );
    await server.drain();
    expect(aborted).toBe(true);
  });

  it("answers tasks/get so the gateway can reconcile", async () => {
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ({ verdict: "approved" }) },
      authenticate,
      fetchImpl: (async () => ({ ok: true }) as Response) as unknown as typeof fetch,
    });

    const created = await server.handle(post(sendBody()));
    const id = (created.body as { result: { id: string } }).result.id;
    await server.drain();

    const res = await server.handle(
      post({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id } }),
    );
    expect(
      (res.body as { result: { status: { state: string } } }).result.status.state,
    ).toBe("completed");
  });

  it("reports an unknown task rather than inventing one", async () => {
    const server = createA2AServer({ card: CARD, skills: {}, authenticate });
    const res = await server.handle(
      post({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "nope" } }),
    );
    expect((res.body as { error: { code: number } }).error.code).toBe(-32001);
  });

  it("rejects a skill it does not implement", async () => {
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ({}) },
      authenticate,
    });
    const res = await server.handle(
      post(sendBody({ metadata: { skillId: "develop.issue" } })),
    );
    expect((res.body as { error: { message: string } }).error.message).toContain(
      "unknown skill",
    );
  });

  it("infers the skill when only one is implemented", async () => {
    const server = createA2AServer({
      card: CARD,
      skills: { "review.pr": async () => ({ ok: true }) },
      authenticate,
      fetchImpl: (async () => ({ ok: true }) as Response) as unknown as typeof fetch,
    });
    const res = await server.handle(post(sendBody({ metadata: {} })));
    expect(res.status).toBe(200);
    expect((res.body as { result?: unknown }).result).toBeTruthy();
    await server.drain();
  });
});
