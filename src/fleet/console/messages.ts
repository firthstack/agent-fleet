import type { A2AClient, AgentCredential } from "../site/a2aClient.js";
import type { A2APart } from "../protocol/a2a.js";
import type { FleetTaskRecord, GatewayAgentRecord } from "../site/gatewayStore.js";
import { checkPayload, type PayloadIssue } from "../validation/payload.js";

/**
 * A message sent from the dashboard by a person (docs/fleet-console.md §8).
 *
 * It becomes an ordinary `fleet_tasks` row and so inherits the deadline sweep,
 * the callback token and the retry machinery. Two things differ from every
 * other caller, and both are deliberate:
 *
 *   The caller is a user, written `user:<id>` — the same shape the
 *   composition layer already uses for `workflow:<run_id>`. Registering a
 *   fake agent for the console would have put it in the catalog, matched it
 *   by skill, and made it dispatchable by a workflow.
 *
 *   There is no caller webhook. A browser is not a push target, so nothing is
 *   notified on completion; the page polls the task instead.
 *
 * The target is named in the URL rather than resolved by skill, so unlike the
 * workflow dispatcher there is no agent to pick and nothing to be ambiguous
 * about.
 */

export class ConsoleDispatchError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_skill" | "invalid_payload" | "dispatch_failed",
    /** Per-field detail, for `invalid_payload`. */
    readonly issues: PayloadIssue[] = [],
  ) {
    super(message);
    this.name = "ConsoleDispatchError";
  }
}

/**
 * A skill whose schema describes an object with required properties cannot be
 * driven by a bare text message. Saying so here beats the agent saying it in
 * an hour.
 */
function requiresStructuredInput(schema: unknown): boolean {
  const s = schema as { type?: unknown; required?: unknown } | null;
  return (
    !!s &&
    typeof s === "object" &&
    s.type === "object" &&
    Array.isArray(s.required) &&
    s.required.length > 0
  );
}

export interface ConsoleMessageStore {
  getAgentCredential(
    tenantId: number,
    agentId: string,
  ): Promise<AgentCredential | null>;
  createTask(input: {
    tenantId: number;
    upstreamTaskId: string;
    callerAgentId: string;
    targetAgentId: string;
    skillId: string;
    deadlineAt: Date;
  }): Promise<FleetTaskRecord>;
  attachDownstream(
    taskId: number,
    input: { downstreamTaskId: string; callbackTokenHash: string },
  ): Promise<void>;
  failTask(taskId: number, result: unknown): Promise<void>;
  appendTaskEvent(input: {
    tenantId: number;
    taskId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void>;
}

export interface ConsoleMessengerDeps {
  store: ConsoleMessageStore;
  client: A2AClient;
  publicBaseUrl: string;
  newUpstreamTaskId(): string;
  newCallbackToken(): string;
  hashToken(token: string): string;
  now?(): Date;
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function createConsoleMessenger(deps: ConsoleMessengerDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async send(input: {
      tenantId: number;
      userId: string;
      target: GatewayAgentRecord;
      skillId: string;
      parts: A2APart[];
      deadlineAt?: Date;
    }): Promise<FleetTaskRecord> {
      // The card is the agent's own statement of what it accepts, so a skill
      // that is not on it would fail at the agent minutes from now instead of
      // here.
      const skills = input.target.card.skills ?? [];
      const offered = skills.map((s) => s.id);
      if (!offered.includes(input.skillId)) {
        throw new ConsoleDispatchError(
          `${input.target.agentId} does not offer ${input.skillId}` +
            (offered.length > 0 ? ` (it offers ${offered.join(", ")})` : ""),
          "unknown_skill",
        );
      }

      // The card may also say what that skill *accepts*. Checking it here is
      // the same bet as the skill id above, one level deeper: a payload the
      // agent will reject costs a dispatch, a deadline and a callback before
      // anyone finds out.
      //
      // A payload is one data part — the shape the workflow dispatcher sends
      // too, so both callers are measured against the same thing.
      const schema = skills.find((s) => s.id === input.skillId)?.inputSchema;
      if (schema !== undefined && schema !== null) {
        const dataParts = input.parts.filter((part) => part.kind === "data");
        if (dataParts.length === 1) {
          const issues = checkPayload(schema, (dataParts[0] as { data: unknown }).data);
          if (issues.length > 0) {
            throw new ConsoleDispatchError(
              `the payload does not match what ${input.skillId} accepts`,
              "invalid_payload",
              issues,
            );
          }
        } else if (dataParts.length === 0 && requiresStructuredInput(schema)) {
          throw new ConsoleDispatchError(
            `${input.skillId} expects structured input, not text alone`,
            "invalid_payload",
            [{ path: "(payload)", message: "send a data part matching the skill's schema" }],
          );
        }
        // Several data parts: the schema describes one payload, so there is
        // nothing here it can be checked against. Left to the agent.
      }

      const deadlineAt =
        input.deadlineAt ?? new Date(now().getTime() + (deps.defaultTtlMs ?? DEFAULT_TTL_MS));
      const upstreamTaskId = deps.newUpstreamTaskId();
      const task = await deps.store.createTask({
        tenantId: input.tenantId,
        upstreamTaskId,
        callerAgentId: `user:${input.userId}`,
        targetAgentId: input.target.agentId,
        skillId: input.skillId,
        deadlineAt,
      });

      const callbackToken = deps.newCallbackToken();
      try {
        const sent = await deps.client.sendMessage({
          endpointUrl: input.target.endpointUrl,
          credential: await deps.store.getAgentCredential(
            input.tenantId,
            input.target.agentId,
          ),
          parts: input.parts,
          skillId: input.skillId,
          deadlineAt,
          contextId: upstreamTaskId,
          pushNotificationConfig: {
            url: new URL(
              `/a2a/callbacks/${callbackToken}`,
              deps.publicBaseUrl,
            ).toString(),
            token: callbackToken,
          },
        });
        await deps.store.attachDownstream(task.id, {
          downstreamTaskId: sent.taskId,
          callbackTokenHash: deps.hashToken(callbackToken),
        });
        await deps.store.appendTaskEvent({
          tenantId: input.tenantId,
          taskId: task.id,
          eventType: "dispatched",
          payload: { targetAgentId: input.target.agentId, callerUserId: input.userId },
        });
      } catch (err) {
        // Close the row out so the deadline sweep does not resurrect a task
        // that never left the process.
        const error = err instanceof Error ? err.message : String(err);
        await deps.store.failTask(task.id, { error });
        await deps.store.appendTaskEvent({
          tenantId: input.tenantId,
          taskId: task.id,
          eventType: "dispatch_failed",
          payload: { error },
        });
        throw new ConsoleDispatchError(
          `dispatching ${input.skillId} to ${input.target.agentId} failed: ${error}`,
          "dispatch_failed",
        );
      }

      return task;
    },
  };
}
