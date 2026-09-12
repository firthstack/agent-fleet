import { randomBytes, createHash } from "node:crypto";
import type { A2AAgentCard, A2ASkill } from "../protocol/a2a.js";
import type { AgentCredential } from "./a2aClient.js";
import type { GatewayAgentRecord } from "./gatewayStore.js";
import { safeFetch, SsrfBlockedError, type UrlPolicy, type LookupFn } from "./ssrf.js";

/**
 * Tenant self-service registration (docs §5). This replaces the old flow
 * where an admin hand-created a row and hand-delivered a one-time token —
 * which no third party could ever complete.
 */

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/** Appears in URLs and in the registry's composite key. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function assertValidAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) {
    throw new RegistrationError(
      "agent id must be 3-64 chars of lowercase letters, digits and hyphens, " +
        "starting and ending alphanumeric",
      "invalid_agent_id",
    );
  }
}

function asSkill(value: unknown, index: number): A2ASkill {
  const s = value as Partial<A2ASkill> | null;
  if (!s || typeof s.id !== "string" || s.id.length === 0) {
    throw new RegistrationError(
      `card.skills[${index}].id is required`,
      "invalid_card",
    );
  }
  if (typeof s.name !== "string" || typeof s.description !== "string") {
    throw new RegistrationError(
      `card.skills[${index}] needs a name and description`,
      "invalid_card",
    );
  }
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    ...(s.inputSchema === undefined ? {} : { inputSchema: s.inputSchema }),
  };
}

/**
 * The card arrives from a tenant-controlled server, so nothing in it is
 * trusted until checked. Unknown fields are kept — A2A grows, and dropping
 * them would silently degrade a newer agent.
 */
export function validateAgentCard(value: unknown): A2AAgentCard {
  const card = value as Partial<A2AAgentCard> | null;
  if (!card || typeof card !== "object") {
    throw new RegistrationError("agent card is not an object", "invalid_card");
  }
  if (typeof card.name !== "string" || card.name.length === 0) {
    throw new RegistrationError("card.name is required", "invalid_card");
  }
  if (typeof card.version !== "string" || card.version.length === 0) {
    throw new RegistrationError("card.version is required", "invalid_card");
  }
  if (!Array.isArray(card.skills) || card.skills.length === 0) {
    throw new RegistrationError(
      "card.skills must list at least one skill",
      "invalid_card",
    );
  }

  const skills = card.skills.map(asSkill);
  const ids = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id)) {
      throw new RegistrationError(
        `card.skills has a duplicate id: ${skill.id}`,
        "invalid_card",
      );
    }
    ids.add(skill.id);
  }

  return {
    ...card,
    name: card.name,
    description: typeof card.description === "string" ? card.description : "",
    version: card.version,
    skills,
  };
}

export function newAgentToken(): string {
  return `fleet_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface RegistrationStorePort {
  getAgent(tenantId: number, agentId: string): Promise<GatewayAgentRecord | null>;
  registerAgent(input: {
    tenantId: number;
    agentId: string;
    displayName: string;
    endpointUrl: string;
    card: A2AAgentCard;
    health?: "unknown" | "healthy" | "unreachable" | "stale";
  }): Promise<GatewayAgentRecord>;
  issueAgentToken(
    tenantId: number,
    agentId: string,
    tokenHash: string,
  ): Promise<void>;
  putAgentCredential(
    tenantId: number,
    agentId: string,
    credential: AgentCredential,
  ): Promise<void>;
  deleteAgentCredential(tenantId: number, agentId: string): Promise<void>;
  rotateAgentToken(
    tenantId: number,
    agentId: string,
    newTokenHash: string,
  ): Promise<{ revoked: number }>;
  /**
   * Conditional write used by the health sweep: never inserts, and only
   * lands if both `expectedVersion` and `expectedRowId` still match what is
   * stored — the row id catches a delete-and-re-register that landed a
   * fresh row whose version happens to coincide with the one this probe
   * captured (docs §5 step 5).
   */
  updateAgentProbe(input: {
    tenantId: number;
    agentId: string;
    expectedVersion: number | null;
    expectedRowId: number | null;
    card: A2AAgentCard;
    health: "healthy" | "unreachable";
  }): Promise<GatewayAgentRecord | null>;
}

export interface RegistrationDeps {
  store: RegistrationStorePort;
  ssrfPolicy?: UrlPolicy;
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  mintToken?: () => string;
}

export interface RegisterAgentInput {
  tenantId: number;
  agentId: string;
  endpointUrl: string;
  displayName?: string;
  /** What the gateway must present when calling this agent. */
  credential?: AgentCredential;
}

export interface RegisterAgentResult {
  agent: GatewayAgentRecord;
  /** Shown once, never recoverable. */
  token: string;
}

/**
 * `safeFetch`'s own timer covers only the wait for response headers — once
 * they arrive it clears the timeout, so a server that sends headers and then
 * never finishes the body can stall a reader indefinitely. This races the
 * body read against its own deadline. The timeout aborts the fetch's own
 * `AbortController` rather than calling `body.cancel()`: by the time the
 * deadline fires, `res.json()` already holds the stream's reader lock, and
 * `cancel()` on a locked stream rejects with "ReadableStream is locked" —
 * silently, if that rejection isn't handled — leaving the connection and the
 * in-flight read running. Aborting works regardless of who holds the lock.
 */
class ProbeTimeoutError extends Error {}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
    // Once `deadline` wins the race, `promise` is still pending and nothing
    // else awaits it; aborting unblocks it, but its eventual rejection would
    // otherwise surface as an unhandled rejection.
    promise.catch(() => {});
  }
}

export function createRegistrationService(deps: RegistrationDeps) {
  const mintToken = deps.mintToken ?? newAgentToken;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function fetchCard(endpointUrl: string): Promise<A2AAgentCard> {
    const cardUrl = new URL(
      "/.well-known/agent-card.json",
      endpointUrl,
    ).toString();

    // Owned here (not just inside `safeFetch`) so the body-read deadline
    // below can abort the same underlying request: `safeFetch` clears its
    // own timer once headers arrive, but this controller stays live for as
    // long as the caller holds onto it.
    const controller = new AbortController();
    let res: Response;
    try {
      res = await safeFetch(
        cardUrl,
        { headers: { accept: "application/json" } },
        {
          policy: deps.ssrfPolicy,
          lookup: deps.lookup,
          fetchImpl: deps.fetchImpl,
          timeoutMs,
          controller,
        },
      );
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new RegistrationError(err.message, "endpoint_rejected");
      }
      throw new RegistrationError(
        `could not reach ${cardUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "unreachable",
      );
    }

    if (!res.ok) {
      throw new RegistrationError(
        `agent card request returned ${res.status}`,
        "unreachable",
      );
    }

    let payload: unknown;
    try {
      payload = await withDeadline(res.json(), timeoutMs, () => {
        controller.abort();
      });
    } catch (err) {
      if (err instanceof ProbeTimeoutError) {
        throw new RegistrationError(
          `agent card body did not complete within ${timeoutMs}ms`,
          "unreachable",
        );
      }
      throw new RegistrationError("agent card is not valid JSON", "invalid_card");
    }

    return validateAgentCard(payload);
  }

  return {
    fetchCard,

    async register(input: RegisterAgentInput): Promise<RegisterAgentResult> {
      assertValidAgentId(input.agentId);

      // Uniqueness is per tenant, so another tenant's `dev-agent` is no
      // obstacle (docs §10, UNIQUE (tenant_id, agent_id)).
      if (await deps.store.getAgent(input.tenantId, input.agentId)) {
        throw new RegistrationError(
          `agent id is already taken in this tenant: ${input.agentId}`,
          "agent_id_taken",
        );
      }

      const card = await fetchCard(input.endpointUrl);
      const agent = await deps.store.registerAgent({
        tenantId: input.tenantId,
        agentId: input.agentId,
        displayName: input.displayName ?? card.name,
        endpointUrl: input.endpointUrl,
        card,
        health: "healthy",
      });

      if (input.credential) {
        await deps.store.putAgentCredential(
          input.tenantId,
          input.agentId,
          input.credential,
        );
      }

      const token = mintToken();
      await deps.store.issueAgentToken(
        input.tenantId,
        input.agentId,
        hashToken(token),
      );

      return { agent, token };
    },

    /**
     * Replace the agent's inbound token. Everything issued before it stops
     * working the moment this returns, so an agent mid-dispatch will fail its
     * callback until the new value is in its config — which is the correct
     * trade when the reason to rotate is that the old one leaked.
     */
    async rotateToken(
      agent: Pick<GatewayAgentRecord, "tenantId" | "agentId">,
    ): Promise<{ token: string; revoked: number }> {
      const token = mintToken();
      const { revoked } = await deps.store.rotateAgentToken(
        agent.tenantId,
        agent.agentId,
        hashToken(token),
      );
      return { token, revoked };
    },

    /**
     * Change an agent in place.
     *
     * A new endpoint is not a field write: the card lives at the endpoint, so
     * the URL goes through the same SSRF policy and card validation as a fresh
     * registration, and what gets stored is what actually answered there. An
     * agent that moved to an address serving nothing keeps its old row.
     *
     * `credential: null` clears the outbound credential; omitting it leaves
     * whatever is stored alone, so a display-name edit cannot silently drop
     * the secret the gateway calls this agent with.
     */
    async update(
      agent: GatewayAgentRecord,
      changes: {
        displayName?: string;
        endpointUrl?: string;
        credential?: AgentCredential | null;
      },
    ): Promise<GatewayAgentRecord> {
      const endpointUrl = changes.endpointUrl ?? agent.endpointUrl;
      const moved = endpointUrl !== agent.endpointUrl;
      const card = moved ? await fetchCard(endpointUrl) : agent.card;

      const updated = await deps.store.registerAgent({
        tenantId: agent.tenantId,
        agentId: agent.agentId,
        displayName: changes.displayName ?? (moved ? card.name : agent.displayName),
        endpointUrl,
        card,
        health: moved ? "healthy" : agent.health,
      });

      if (changes.credential === null) {
        await deps.store.deleteAgentCredential(agent.tenantId, agent.agentId);
      } else if (changes.credential) {
        await deps.store.putAgentCredential(
          agent.tenantId,
          agent.agentId,
          changes.credential,
        );
      }

      return updated;
    },

    /**
     * Periodic health check (docs §5 step 5). Re-fetching the card doubles as
     * the liveness probe and as the trigger for rebuilding the skill index,
     * so an agent that drops a skill stops matching it.
     */
    async refresh(
      agent: GatewayAgentRecord,
    ): Promise<{ health: "healthy" | "unreachable"; changed: boolean }> {
      let card = agent.card;
      let health: "healthy" | "unreachable" = "unreachable";
      try {
        card = await fetchCard(agent.endpointUrl);
        health = "healthy";
      } catch {
        // Left as `agent.card` / "unreachable" — a probe failure keeps the
        // last known card rather than blanking it.
      }

      // A conditional update, never an insert: an edit or delete that landed
      // while this probe was in flight wins over the stale snapshot the
      // sweep started with (docs §5 step 5).
      await deps.store.updateAgentProbe({
        tenantId: agent.tenantId,
        agentId: agent.agentId,
        expectedVersion: agent.probeVersion ?? null,
        expectedRowId: agent.rowId ?? null,
        card,
        health,
      });

      const changed = JSON.stringify(card) !== JSON.stringify(agent.card);
      return { health, changed };
    },
  };
}

export interface HealthSweepStorePort {
  listAllAgentsUnscoped(): Promise<GatewayAgentRecord[]>;
}

/**
 * The background half of registration step 5 (docs §5): drives `refresh()`
 * over every agent in every tenant. Without a caller for this, health is
 * written once at registration and never again — an agent that goes down
 * keeps reading "healthy" on the dashboard forever.
 */
export function createHealthSweeper(deps: {
  store: HealthSweepStorePort;
  refresh(
    agent: GatewayAgentRecord,
  ): Promise<{ health: "healthy" | "unreachable"; changed: boolean }>;
  /**
   * Called when a single agent's probe throws (e.g. the store rejects the
   * write). Without this, one bad agent's failure would otherwise propagate
   * out of the loop below and abort the sweep for every remaining tenant.
   */
  onError?(agent: GatewayAgentRecord, error: unknown): void;
}) {
  return async function runOnce(): Promise<{ checked: number; unreachable: number }> {
    const agents = await deps.store.listAllAgentsUnscoped();
    let unreachable = 0;
    for (const agent of agents) {
      try {
        const result = await deps.refresh(agent);
        if (result.health === "unreachable") unreachable += 1;
      } catch (err) {
        deps.onError?.(agent, err);
      }
    }
    return { checked: agents.length, unreachable };
  };
}
