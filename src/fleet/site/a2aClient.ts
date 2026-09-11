import type {
  A2AAgentCard,
  A2APart,
  PushNotificationConfig,
} from "../protocol/a2a.js";

/**
 * Outbound A2A client — the gateway's *client* half (docs §2). It speaks to a
 * registered agent's real endpoint, which no caller ever sees.
 */

export interface AgentCredential {
  scheme: "bearer" | "apiKey" | "oauth2" | "mtls";
  secret: string;
  /** Header name for `apiKey`; defaults to `x-api-key`. */
  headerName?: string;
}

export interface SendMessageArgs {
  endpointUrl: string;
  credential?: AgentCredential | null;
  /** Opaque to the gateway; forwarded verbatim from the caller. */
  parts: A2APart[];
  skillId: string;
  /** Where the target should report completion (docs §7 step ③). */
  pushNotificationConfig: PushNotificationConfig;
  /** Shared by all three parties so nobody gives up early (docs §8). */
  deadlineAt: Date;
  contextId?: string;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  /** The task id the *downstream* agent minted. */
  taskId: string;
  state: string;
}

export interface A2AClient {
  fetchAgentCard(endpointUrl: string, signal?: AbortSignal): Promise<A2AAgentCard>;
  sendMessage(args: SendMessageArgs): Promise<SendMessageResult>;
}

export class A2ARequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "A2ARequestError";
  }
}

function authHeaders(credential?: AgentCredential | null): Record<string, string> {
  if (!credential) return {};
  switch (credential.scheme) {
    case "bearer":
    case "oauth2":
      return { authorization: `Bearer ${credential.secret}` };
    case "apiKey":
      return { [credential.headerName ?? "x-api-key"]: credential.secret };
    case "mtls":
      // Client certificates are established at the TLS layer, not here.
      return {};
  }
}

function agentCardUrl(endpointUrl: string): string {
  return new URL("/.well-known/agent-card.json", endpointUrl).toString();
}

export function createA2AClient(opts: { fetchImpl?: typeof fetch } = {}): A2AClient {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async fetchAgentCard(endpointUrl, signal) {
      const res = await doFetch(agentCardUrl(endpointUrl), {
        headers: { accept: "application/json" },
        signal,
      });
      if (!res.ok) {
        throw new A2ARequestError(
          `agent card fetch failed: ${res.status}`,
          res.status,
        );
      }
      return (await res.json()) as A2AAgentCard;
    },

    async sendMessage(args) {
      const body = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "message/send",
        params: {
          message: {
            role: "user" as const,
            parts: args.parts,
          },
          configuration: {
            pushNotificationConfig: args.pushNotificationConfig,
          },
          metadata: {
            skillId: args.skillId,
            deadlineAt: args.deadlineAt.toISOString(),
            ...(args.contextId ? { contextId: args.contextId } : {}),
          },
        },
      };

      const res = await doFetch(args.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...authHeaders(args.credential),
        },
        body: JSON.stringify(body),
        signal: args.signal,
      });

      if (!res.ok) {
        throw new A2ARequestError(
          `message/send failed: ${res.status} ${await res.text()}`,
          res.status,
        );
      }

      const payload = (await res.json()) as {
        result?: { id?: string; status?: { state?: string } };
        error?: { code?: number; message?: string };
      };
      if (payload.error) {
        throw new A2ARequestError(
          `message/send rejected: ${payload.error.message ?? payload.error.code}`,
        );
      }
      const taskId = payload.result?.id;
      if (!taskId) {
        throw new A2ARequestError("message/send returned no task id");
      }
      return { taskId, state: payload.result?.status?.state ?? "submitted" };
    },
  };
}
