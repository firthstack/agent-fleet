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

export function createRegistrationService(deps: RegistrationDeps) {
  const mintToken = deps.mintToken ?? newAgentToken;

  async function fetchCard(endpointUrl: string): Promise<A2AAgentCard> {
    const cardUrl = new URL(
      "/.well-known/agent-card.json",
      endpointUrl,
    ).toString();

    let res: Response;
    try {
      res = await safeFetch(
        cardUrl,
        { headers: { accept: "application/json" } },
        {
          policy: deps.ssrfPolicy,
          lookup: deps.lookup,
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs ?? 10_000,
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
    try {
      return validateAgentCard(await res.json());
    } catch (err) {
      if (err instanceof RegistrationError) throw err;
      throw new RegistrationError("agent card is not valid JSON", "invalid_card");
    }
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
     * Periodic health check (docs §5 step 5). Re-fetching the card doubles as
     * the liveness probe and as the trigger for rebuilding the skill index,
     * so an agent that drops a skill stops matching it.
     */
    async refresh(
      agent: GatewayAgentRecord,
    ): Promise<{ health: "healthy" | "unreachable"; changed: boolean }> {
      let card: A2AAgentCard;
      try {
        card = await fetchCard(agent.endpointUrl);
      } catch {
        await deps.store.registerAgent({
          tenantId: agent.tenantId,
          agentId: agent.agentId,
          displayName: agent.displayName,
          endpointUrl: agent.endpointUrl,
          card: agent.card,
          health: "unreachable",
        });
        return { health: "unreachable", changed: false };
      }

      const changed = JSON.stringify(card) !== JSON.stringify(agent.card);
      await deps.store.registerAgent({
        tenantId: agent.tenantId,
        agentId: agent.agentId,
        displayName: agent.displayName,
        endpointUrl: agent.endpointUrl,
        card,
        health: "healthy",
      });
      return { health: "healthy", changed };
    },
  };
}
