import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { StartedTestContainer } from "testcontainers";
import { startPostgres } from "./support/postgres.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../../src/fleet/site/gatewayStore.js";
import { createA2AClient } from "../../src/fleet/site/a2aClient.js";
import { createFleetSiteServer, startFleetWorkers } from "../../src/fleet/site/server.js";
import { hashToken } from "../../src/fleet/site/registration.js";
import { createAesSecretBox, parseSecretKey } from "../../src/fleet/site/secretBox.js";
import { createWorkflowDriver } from "../../src/fleet/workflow/driver.js";
import { createWorkflowDispatcher } from "../../src/fleet/workflow/dispatcher.js";
import type { WorkflowStore } from "../../src/fleet/workflow/workflowStore.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";
import {
  bearerAuthenticator,
  createA2AAgentHttpServer,
  createA2AServer,
  type SkillHandler,
} from "../../src/fleet/runtime/a2aServer.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

/**
 * The whole composition layer over real HTTP: the gateway dispatches to A2A
 * agents running the real agent runtime, they call back to the real callback
 * endpoint, the driver claims the finished step from the real Postgres queue
 * and dispatches the next one.
 *
 * Nothing here is stubbed except the agents' business logic — which is the
 * one part the fleet is not responsible for.
 */

const EXTERNAL_URL = process.env.FLEET_TEST_DATABASE_URL?.trim();
const PR = "https://github.com/o/r/pull/7";
const PR2 = "https://github.com/o/r/pull/8";

let container: StartedTestContainer | undefined;
let store: GatewayStore;
let workflows: WorkflowStore;
let siteUrl = "";
let tenantId = 0;
let callerToken = "";
let servers: Server[] = [];
let workers: { stop(): void; runOnce(): Promise<void> } | undefined;

const definition = JSON.parse(
  await readFile("workflows/develop-review-merge.json", "utf8"),
) as WorkflowDefinition;

/** An agent that answers one skill with whatever the test queued up. */
async function startStubAgent(input: {
  name: string;
  token: string;
  skills: Record<string, SkillHandler>;
}): Promise<{ url: string; server: Server }> {
  const card: A2AAgentCard = {
    name: input.name,
    description: input.name,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    skills: Object.keys(input.skills).map((id) => ({
      id,
      name: id,
      description: id,
    })),
  };
  const server = createA2AAgentHttpServer({
    server: createA2AServer({
      card,
      skills: input.skills,
      authenticate: bearerAuthenticator(input.token),
      notifyBaseDelayMs: 5,
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server };
}

beforeAll(async () => {
  let connectionString = EXTERNAL_URL;
  if (!connectionString) {
    const started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;
  }

  store = new GatewayStore({
    connectionString,
    insecureSsl: !EXTERNAL_URL,
    secretBox: createAesSecretBox(parseSecretKey(randomBytes(32).toString("hex"))),
  });
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await store.migrate(await readFile(`migrations/${file}`, "utf8"));
  }
  workflows = store.workflows();
}, 180_000);

afterAll(async () => {
  workers?.stop();
  for (const server of servers) server.close();
  await store?.close();
  await container?.stop();
});

beforeEach(async () => {
  workers?.stop();
  for (const server of servers) server.close();
  servers = [];
  await store.truncateAll();
  await store.migrate(
    "TRUNCATE fleet_workflows, fleet_workflow_runs, fleet_workflow_run_events RESTART IDENTITY CASCADE",
  );

  const tenant = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
  tenantId = tenant.id;
});

/** Bring up the gateway, wired exactly the way index.ts wires it. */
/** Reset per test; one test's limit must not leak into the next. */
let runLimit = 100;

async function startGateway() {
  // The public base URL has to be the address the agents can actually reach,
  // because every callback URL is built from it.
  const placeholder = createFleetSiteServer({
    store,
    publicBaseUrl: "http://127.0.0.1:1",
  });
  await new Promise<void>((resolve) => placeholder.listen(0, "127.0.0.1", resolve));
  const { port } = placeholder.address() as AddressInfo;
  placeholder.close();

  const publicBaseUrl = `http://127.0.0.1:${port}`;
  const driver = createWorkflowDriver({
    store: workflows,
    maxConcurrentRunsPerTenant: runLimit,
    dispatcher: createWorkflowDispatcher({
      store,
      client: createA2AClient(),
      publicBaseUrl,
      newUpstreamTaskId: () => randomBytes(16).toString("hex"),
      newCallbackToken: () => randomBytes(32).toString("base64url"),
      hashToken,
    }),
  });

  const server = createFleetSiteServer({
    store,
    publicBaseUrl,
    workflows,
    workflowStarter: driver,
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  siteUrl = publicBaseUrl;
  workers = startFleetWorkers({
    store,
    workflowDriver: driver,
    intervalMs: 1_000_000, // driven by hand in the tests
  });
  return { driver };
}

async function registerAgent(agentId: string, url: string, token: string, skills: string[]) {
  await store.registerAgent({
    tenantId,
    agentId,
    displayName: agentId,
    endpointUrl: url,
    card: {
      name: agentId,
      description: agentId,
      version: "1.0.0",
      skills: skills.map((id) => ({ id, name: id, description: id })),
    },
  });
  await store.putAgentCredential(tenantId, agentId, { scheme: "bearer", secret: token });
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(new URL(path, siteUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${callerToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() };
}

/** Tick the workers until the run reaches a terminal state, or give up. */
async function settle(runId: number, maxTicks = 40) {
  for (let i = 0; i < maxTicks; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    await workers!.runOnce();
    const run = await workflows.getRun(tenantId, runId);
    if (run && ["completed", "failed", "needs_human", "cancelled"].includes(run.state)) {
      return run;
    }
  }
  return workflows.getRun(tenantId, runId);
}

async function setUpFleet(opts: {
  reviewVerdicts?: Array<"approved" | "request_changes" | "comment">;
  /** Runs inside the develop stub, so a test can observe how many are at the
   *  agent simultaneously. */
  onDevelop?(): Promise<void>;
  developOk?: boolean;
  mergeOk?: boolean;
  /** Leave the merge agent unregistered, so `pr.merge` has nowhere to go. */
  withMergeAgent?: boolean;
}) {
  await startGateway();

  const verdicts = [...(opts.reviewVerdicts ?? ["approved"])];
  let reviewCalls = 0;
  let developCalls = 0;

  const devToken = "dev-secret";
  const dev = await startStubAgent({
    name: "dev-agent",
    token: devToken,
    skills: {
      "develop.issue": async () => {
        developCalls += 1;
        await opts.onDevelop?.();
        return opts.developOk === false
          ? { ok: false, error: "could not push" }
          : { ok: true, prUrl: PR };
      },
      "develop.revise": async () => {
        developCalls += 1;
        return { ok: true, prUrl: PR2 };
      },
    },
  });

  const reviewToken = "review-secret";
  const review = await startStubAgent({
    name: "review-agent",
    token: reviewToken,
    skills: {
      "review.pr": async () => {
        const verdict = verdicts[Math.min(reviewCalls, verdicts.length - 1)];
        reviewCalls += 1;
        return {
          ok: true,
          verdict,
          reviewUrl: "https://github.com/review/1",
          findings: verdict === "request_changes" ? [{ title: "t", detail: "d" }] : [],
        };
      },
    },
  });

  const mergeToken = "merge-secret";
  const merge = await startStubAgent({
    name: "pr-merge-agent",
    token: mergeToken,
    skills: {
      "pr.merge": async () =>
        opts.mergeOk === false
          ? { ok: false, error: "slack rejected" }
          : { ok: true, slackMessageTs: "1.2" },
    },
  });

  await registerAgent("dev-agent", dev.url, devToken, ["develop.issue", "develop.revise"]);
  await registerAgent("review-agent", review.url, reviewToken, ["review.pr"]);
  if (opts.withMergeAgent !== false) {
    await registerAgent("pr-merge-agent", merge.url, mergeToken, ["pr.merge"]);
  }

  // A caller identity for the HTTP API.
  callerToken = `fleet_${randomBytes(16).toString("hex")}`;
  await registerAgent("caller", dev.url, "unused", []);
  await store.issueAgentToken(tenantId, "caller", hashToken(callerToken));

  await api("/a2a/t/acme/workflows/develop-review-merge/1", {
    method: "PUT",
    body: JSON.stringify(definition),
  });

  return {
    reviewCalls: () => reviewCalls,
    developCalls: () => developCalls,
  };
}

async function startRun(sourceRef = "issue-9") {
  const res = await api("/a2a/t/acme/workflows/develop-review-merge/runs", {
    method: "POST",
    body: JSON.stringify({
      payload: { requirement: "Add fleet composition" },
      sourceRef,
    }),
  });
  return res;
}

describe("the whole fleet, over real HTTP", () => {
  it("carries develop → review → merge to completion", async () => {
    const fleet = await setUpFleet({ reviewVerdicts: ["approved"] });

    const started = await startRun();
    expect(started.status).toBe(201);
    const runId = (started.body as { run: { id: number } }).run.id;

    const run = await settle(runId);
    expect(run).toMatchObject({ state: "completed", status: "completed" });
    expect(fleet.developCalls()).toBe(1);
    expect(fleet.reviewCalls()).toBe(1);

    // The timeline the run viewer would render, including the pass-through
    // state that dispatches nothing.
    const events = await api(`/a2a/t/acme/workflows/runs/${runId}/events`);
    expect(
      (events.body as { events: Array<{ eventType: string }> }).events.map(
        (e) => e.eventType,
      ),
    ).toEqual([
      "created",
      "developing",
      "pr_opened",
      "reviewing",
      "requesting_merge",
      "completed",
    ]);
  }, 60_000);

it("fails the run when a step names a skill no agent offers", async () => {
    // The real incident this comes from: develop and review both succeed, and
    // then `requesting_merge` calls `pr.merge`, which nothing in the tenant
    // provides.
    //
    // What used to happen: the run row is written before the dispatch, so the
    // run moved to `requesting_merge` and the dispatch then threw. That threw
    // onto the retry path, which rewrote the same state five times over eight
    // minutes and gave up. No task row was ever created for the step — the
    // dispatcher refuses before creating one — and the deadline sweep only
    // looks at `fleet_tasks`, so nothing afterwards could ever move the run.
    // It sat in a live-looking `requesting_merge` forever.
    const fleet = await setUpFleet({
      reviewVerdicts: ["approved"],
      withMergeAgent: false,
    });

    const started = await startRun();
    const runId = (started.body as { run: { id: number } }).run.id;

    const run = await settle(runId);

    expect(run).toMatchObject({ state: "failed", status: "failed" });
    // The reason names the skill, which is the one thing that says what to do.
    expect(run?.reason).toContain("pr.merge");
    // It got all the way through the work that could be done.
    expect(fleet.developCalls()).toBe(1);
    expect(fleet.reviewCalls()).toBe(1);

    const events = await api(`/a2a/t/acme/workflows/runs/${runId}/events`);
    const types = (events.body as { events: Array<{ eventType: string }> }).events.map(
      (e) => e.eventType,
    );
    expect(types).toEqual([
      "created",
      "developing",
      "pr_opened",
      "reviewing",
      "requesting_merge",
      "failed",
    ]);
  }, 60_000);

it("holds a tenant's submissions to its concurrency limit, then lets them through", async () => {
    // The behaviour a single workflow agent used to give for free by queueing
    // internally. Moving orchestration into the platform lost it: `POST /runs`
    // dispatches inside the request, so five submissions were five
    // simultaneous dispatches at whichever agent serves the first step.
    runLimit = 2;
    let inFlight = 0;
    let peak = 0;
    const fleet = await setUpFleet({
      reviewVerdicts: ["approved", "approved", "approved", "approved", "approved"],
      onDevelop: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight -= 1;
      },
    });

    const submitted = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => startRun(`burst-${n}`)),
    );
    expect(submitted.every((r) => r.status === 201)).toBe(true);

    // Three are accepted and recorded, holding no slot and touching no agent.
    const queued = submitted.filter(
      (r) => (r.body as { run: { admittedAt: string | null } }).run.admittedAt === null,
    );
    expect(queued).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(2);

    // Nothing is lost: every one of them runs, as slots free up.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      await workers!.runOnce();
      const all = await Promise.all(
        submitted.map((r) =>
          workflows.getRun(tenantId, (r.body as { run: { id: number } }).run.id),
        ),
      );
      if (all.every((run) => run && run.state === "completed")) break;
    }

    const finished = await Promise.all(
      submitted.map((r) =>
        workflows.getRun(tenantId, (r.body as { run: { id: number } }).run.id),
      ),
    );
    expect(finished.map((r) => r?.state)).toEqual(Array(5).fill("completed"));
    expect(fleet.developCalls()).toBe(5);
    // The whole point: never more than the limit at the agent at once.
    expect(peak).toBeLessThanOrEqual(2);
  }, 60_000);

  it("loops through revision when review asks for changes", async () => {
    const fleet = await setUpFleet({
      reviewVerdicts: ["request_changes", "approved"],
    });
    const started = await startRun();
    const runId = (started.body as { run: { id: number } }).run.id;

    const run = await settle(runId);
    expect(run).toMatchObject({ state: "completed" });
    // develop.issue once, then develop.revise once.
    expect(fleet.developCalls()).toBe(2);
    expect(fleet.reviewCalls()).toBe(2);
    // The second review saw the revised PR.
    expect((run?.vars as { prUrl: string }).prUrl).toBe(PR2);

    const events = await api(`/a2a/t/acme/workflows/runs/${runId}/events`);
    expect(
      (events.body as { events: Array<{ eventType: string }> }).events.map(
        (e) => e.eventType,
      ),
    ).toEqual([
      "created",
      "developing",
      "pr_opened",
      "reviewing",
      "changes_requested",
      "revising",
      "pr_opened",
      "reviewing",
      "requesting_merge",
      "completed",
    ]);
  }, 60_000);

  it("escalates to a human when review only comments", async () => {
    await setUpFleet({ reviewVerdicts: ["comment"] });
    const started = await startRun();
    const runId = (started.body as { run: { id: number } }).run.id;

    expect(await settle(runId)).toMatchObject({
      state: "needs_human",
      reason: "review_comment",
    });
  }, 60_000);

  it("fails the run when development cannot open a PR", async () => {
    await setUpFleet({ developOk: false });
    const started = await startRun();
    const runId = (started.body as { run: { id: number } }).run.id;

    expect(await settle(runId)).toMatchObject({
      state: "failed",
      reason: "develop_failed",
    });
  }, 60_000);

  it("fails the run when the merge request is refused", async () => {
    await setUpFleet({ reviewVerdicts: ["approved"], mergeOk: false });
    const started = await startRun();
    const runId = (started.body as { run: { id: number } }).run.id;

    expect(await settle(runId)).toMatchObject({
      state: "failed",
      reason: "merge_request_failed",
    });
  }, 60_000);

  it("does not start a second run for a replayed request", async () => {
    const fleet = await setUpFleet({ reviewVerdicts: ["approved"] });
    const first = await startRun("issue-same");
    const second = await startRun("issue-same");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as { deduplicated: boolean }).deduplicated).toBe(true);
    expect((second.body as { run: { id: number } }).run.id).toBe(
      (first.body as { run: { id: number } }).run.id,
    );

    await settle((first.body as { run: { id: number } }).run.id);
    // One PR for one requirement, not two.
    expect(fleet.developCalls()).toBe(1);
  }, 60_000);
});
