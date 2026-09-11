/**
 * A2A-shaped protocol types for the fleet gateway.
 *
 * These replace the `fleet-mailbox` envelope types in ./types.ts. Both files
 * coexist while the agents are converted one at a time (docs §11.3); once
 * workflow-agent is on A2A, ./types.ts loses everything mailbox-related.
 *
 * Note the spec's AgentCard has no identifier field — an A2A agent is
 * identified by its URL. The gateway needs a stable local handle, so
 * `agentId` is assigned by us at registration (docs §5 step 3) and lives in
 * the registry, never in the card itself.
 */

export type A2APart =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: "file"; uri: string; mediaType?: string };

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  /** JSON Schema for this skill's payload. Captured at registration. */
  inputSchema?: unknown;
}

export type A2ASecuritySchemeType = "bearer" | "apiKey" | "oauth2" | "mtls";

export interface A2ASecurityScheme {
  type: A2ASecuritySchemeType;
  description?: string;
  [key: string]: unknown;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  /** The agent's own endpoint. The gateway rewrites this before serving. */
  url?: string;
  skills: A2ASkill[];
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  securitySchemes?: Record<string, A2ASecurityScheme>;
  [key: string]: unknown;
}

/** What the caller registers so the gateway can notify it (docs §7 step ④). */
export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}

export type FleetTaskState =
  | "dispatching"
  | "running"
  | "done_pending_notify"
  | "done"
  | "failed"
  | "timed_out"
  | "cancelled";

/** States from which no further transition happens. */
export const TERMINAL_TASK_STATES: readonly FleetTaskState[] = [
  "done",
  "failed",
  "timed_out",
  "cancelled",
];

export type AgentHealth = "unknown" | "healthy" | "unreachable" | "stale";

/**
 * A single review remark, produced by the review capability and consumed by
 * the development one. Shared here because both sides need the same shape —
 * it used to be declared twice, once per agent.
 */
export interface ReviewFinding {
  severity?: "critical" | "suggestion" | "information";
  location?: string;
  file?: string;
  line?: number;
  title: string;
  detail: string;
}
