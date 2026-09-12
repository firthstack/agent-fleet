import type { A2AClient, AgentCredential } from "../site/a2aClient.js";
import type { FleetTaskRecord, GatewayAgentRecord } from "../site/gatewayStore.js";
// The interface this implements lives in driver.ts, and so does the error
// taxonomy that goes with it: the driver decides which failures are worth a
// retry, so it is the driver's contract to define.
import { WorkflowDispatchError, type WorkflowDispatcher } from "./driver.js";

export { WorkflowDispatchError };

/**
 * Turns a workflow step into an ordinary gateway dispatch (docs §5.1).
 *
 * A workflow step is a normal `fleet_tasks` row and goes through the same
 * ①②③④ chain as any other call, so it inherits the deadline sweep, the
 * callback token and the retry machinery. The only differences: the caller is
 * the run rather than an agent, and there is no caller webhook — completion
 * is claimed by the driver instead.
 */

export interface WorkflowDispatchStore {
  findAgentsBySkill(
    tenantId: number,
    skillId: string,
  ): Promise<GatewayAgentRecord[]>;
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
    workflowRunId?: number | null;
    workflowFromState?: string | null;
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

export interface WorkflowDispatcherDeps {
  store: WorkflowDispatchStore;
  client: A2AClient;
  publicBaseUrl: string;
  newUpstreamTaskId(): string;
  newCallbackToken(): string;
  hashToken(token: string): string;
}

export function createWorkflowDispatcher(
  deps: WorkflowDispatcherDeps,
): WorkflowDispatcher {
  return {
    async dispatch(input) {
      const matches = await deps.store.findAgentsBySkill(
        input.tenantId,
        input.skillId,
      );
      if (matches.length === 0) {
        throw new WorkflowDispatchError(
          `no agent in this tenant offers ${input.skillId}`,
          "no_agent",
        );
      }
      if (matches.length > 1) {
        // The gateway never picks on the caller's behalf (docs §6.1). A
        // silent wrong route is the bug that rule exists to prevent, so a
        // workflow must name the agent rather than let us guess.
        throw new WorkflowDispatchError(
          `${input.skillId} is offered by ${matches.length} agents ` +
            `(${matches.map((m) => m.agentId).join(", ")}); the workflow must name one`,
          "ambiguous_agent",
        );
      }
      const target = matches[0];

      const upstreamTaskId = deps.newUpstreamTaskId();
      const task = await deps.store.createTask({
        tenantId: input.tenantId,
        upstreamTaskId,
        // The run is the caller. There is no agent to notify on completion —
        // the driver claims the finished step instead.
        callerAgentId: `workflow:${input.workflowRunId}`,
        targetAgentId: target.agentId,
        skillId: input.skillId,
        deadlineAt: input.deadlineAt,
        workflowRunId: input.workflowRunId,
        workflowFromState: input.fromState,
      });

      const callbackToken = deps.newCallbackToken();
      try {
        const sent = await deps.client.sendMessage({
          endpointUrl: target.endpointUrl,
          credential: await deps.store.getAgentCredential(
            input.tenantId,
            target.agentId,
          ),
          parts: [{ kind: "data", data: input.payload }],
          skillId: input.skillId,
          deadlineAt: input.deadlineAt,
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
          payload: {
            workflowRunId: input.workflowRunId,
            fromState: input.fromState,
            targetAgentId: target.agentId,
          },
        });
      } catch (err) {
        // Close the task out so the deadline sweep does not later resurrect
        // it, and let the driver's own retry decide what happens next.
        const error = err instanceof Error ? err.message : String(err);
        await deps.store.failTask(task.id, { error });
        throw new WorkflowDispatchError(
          `dispatching ${input.skillId} to ${target.agentId} failed: ${error}`,
          "dispatch_failed",
        );
      }

      return { taskId: task.id };
    },
  };
}
