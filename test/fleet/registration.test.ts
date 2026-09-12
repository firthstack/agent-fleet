import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertValidAgentId,
  createRegistrationService,
  hashToken,
  newAgentToken,
  RegistrationError,
  validateAgentCard,
  type RegistrationStorePort,
} from "../../src/fleet/site/registration.js";
import {
  createAesSecretBox,
  parseSecretKey,
  SecretBoxError,
  secureEquals,
} from "../../src/fleet/site/secretBox.js";
import type { AgentCredential } from "../../src/fleet/site/a2aClient.js";
import type { GatewayAgentRecord } from "../../src/fleet/site/gatewayStore.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

function validCard(): A2AAgentCard {
  return {
    name: "Codex Review Agent",
    description: "Reviews pull requests.",
    version: "1.0.0",
    skills: [{ id: "review.pr", name: "Review PR", description: "Review a PR." }],
  };
}

function fakeStore(seed: GatewayAgentRecord[] = []) {
  const agents = [...seed];
  const tokens: Array<{
    tenantId: number;
    agentId: string;
    hash: string;
    revoked?: boolean;
  }> = [];
  const creds: Array<{ tenantId: number; agentId: string; credential: AgentCredential }> = [];

  const store: RegistrationStorePort = {
    async getAgent(tenantId, agentId) {
      return agents.find((a) => a.tenantId === tenantId && a.agentId === agentId) ?? null;
    },
    async registerAgent(input) {
      const record: GatewayAgentRecord = {
        tenantId: input.tenantId,
        agentId: input.agentId,
        displayName: input.displayName,
        endpointUrl: input.endpointUrl,
        card: input.card,
        health: input.health ?? "healthy",
        cardFetchedAt: "2026-09-11T00:00:00.000Z",
        lastSeenAt: null,
      };
      const i = agents.findIndex(
        (a) => a.tenantId === input.tenantId && a.agentId === input.agentId,
      );
      if (i >= 0) agents[i] = record;
      else agents.push(record);
      return record;
    },
    async issueAgentToken(tenantId, agentId, hash) {
      tokens.push({ tenantId, agentId, hash });
    },
    async putAgentCredential(tenantId, agentId, credential) {
      creds.push({ tenantId, agentId, credential });
    },
    async deleteAgentCredential(tenantId, agentId) {
      for (let i = creds.length - 1; i >= 0; i -= 1) {
        const c = creds[i];
        if (c.tenantId === tenantId && c.agentId === agentId) creds.splice(i, 1);
      }
    },
    async rotateAgentToken(tenantId, agentId, hash) {
      let revoked = 0;
      for (const t of tokens) {
        if (t.tenantId === tenantId && t.agentId === agentId && !t.revoked) {
          t.revoked = true;
          revoked += 1;
        }
      }
      tokens.push({ tenantId, agentId, hash });
      return { revoked };
    },
  };

  return { store, agents, tokens, creds };
}

function cardResponder(card: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => card,
  })) as unknown as typeof fetch;
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("assertValidAgentId", () => {
  it("accepts ids that are safe in a URL path and a composite key", () => {
    for (const id of ["dev-agent", "review-agent", "a1b", "x".repeat(64)]) {
      expect(() => assertValidAgentId(id)).not.toThrow();
    }
  });

  it("rejects ids that would break routing or collide", () => {
    for (const id of ["", "ab", "Dev-Agent", "dev agent", "dev/agent", "-dev", "dev-", "x".repeat(65)]) {
      expect(() => assertValidAgentId(id), id).toThrow(RegistrationError);
    }
  });
});

describe("validateAgentCard", () => {
  it("keeps fields it does not know about", () => {
    // A2A grows; silently dropping unknown fields would degrade a newer agent.
    const out = validateAgentCard({ ...validCard(), futureThing: { a: 1 } });
    expect((out as Record<string, unknown>).futureThing).toEqual({ a: 1 });
  });

  it("requires a name, a version and at least one skill", () => {
    expect(() => validateAgentCard({ version: "1", skills: [{ id: "a", name: "a", description: "a" }] })).toThrow(/name/);
    expect(() => validateAgentCard({ name: "x", skills: [{ id: "a", name: "a", description: "a" }] })).toThrow(/version/);
    expect(() => validateAgentCard({ name: "x", version: "1", skills: [] })).toThrow(/at least one skill/);
  });

  it("rejects duplicate skill ids", () => {
    // Two skills with one id would make the routing index ambiguous.
    expect(() =>
      validateAgentCard({
        name: "x",
        version: "1",
        skills: [
          { id: "review.pr", name: "a", description: "a" },
          { id: "review.pr", name: "b", description: "b" },
        ],
      }),
    ).toThrow(/duplicate id/);
  });

  it("rejects a skill missing its description", () => {
    expect(() =>
      validateAgentCard({ name: "x", version: "1", skills: [{ id: "a", name: "a" }] }),
    ).toThrow(/name and description/);
  });
});

describe("registration", () => {
  it("fetches the card, stores the agent, and returns a one-time token", async () => {
    const f = fakeStore();
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder(validCard()),
      lookup: publicLookup,
      mintToken: () => "fleet_test_token",
    });

    const out = await svc.register({
      tenantId: 1,
      agentId: "review-agent",
      endpointUrl: "https://review.acme.example/",
    });

    expect(out.token).toBe("fleet_test_token");
    expect(out.agent.displayName).toBe("Codex Review Agent");
    // Only the hash is persisted — the token itself is unrecoverable.
    expect(f.tokens[0].hash).toBe(hashToken("fleet_test_token"));
    expect(f.tokens[0].hash).not.toContain("fleet_test_token");
  });

  it("refuses an agent id already used in the same tenant", async () => {
    const existing: GatewayAgentRecord = {
      tenantId: 1,
      agentId: "review-agent",
      displayName: "old",
      endpointUrl: "https://old.example/",
      card: validCard(),
      health: "healthy",
      cardFetchedAt: null,
      lastSeenAt: null,
    };
    const f = fakeStore([existing]);
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder(validCard()),
      lookup: publicLookup,
    });

    await expect(
      svc.register({ tenantId: 1, agentId: "review-agent", endpointUrl: "https://new.example/" }),
    ).rejects.toMatchObject({ code: "agent_id_taken" });
  });

  it("allows the same agent id in a different tenant", async () => {
    const existing: GatewayAgentRecord = {
      tenantId: 1,
      agentId: "review-agent",
      displayName: "acme",
      endpointUrl: "https://acme.example/",
      card: validCard(),
      health: "healthy",
      cardFetchedAt: null,
      lastSeenAt: null,
    };
    const f = fakeStore([existing]);
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder(validCard()),
      lookup: publicLookup,
    });

    await expect(
      svc.register({ tenantId: 2, agentId: "review-agent", endpointUrl: "https://globex.example/" }),
    ).resolves.toBeTruthy();
  });

  it("blocks an endpoint pointing at the metadata service", async () => {
    const f = fakeStore();
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder(validCard()),
      lookup: publicLookup,
    });

    await expect(
      svc.register({
        tenantId: 1,
        agentId: "evil-agent",
        endpointUrl: "https://169.254.169.254/",
      }),
    ).rejects.toMatchObject({ code: "endpoint_rejected" });
    expect(f.agents).toHaveLength(0);
  });

  it("stores the outbound credential when one is supplied", async () => {
    const f = fakeStore();
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder(validCard()),
      lookup: publicLookup,
    });

    await svc.register({
      tenantId: 1,
      agentId: "review-agent",
      endpointUrl: "https://review.acme.example/",
      credential: { scheme: "bearer", secret: "s3cret" },
    });
    expect(f.creds[0]).toMatchObject({
      tenantId: 1,
      agentId: "review-agent",
      credential: { scheme: "bearer", secret: "s3cret" },
    });
  });

  it("does not register an agent whose card is malformed", async () => {
    const f = fakeStore();
    const svc = createRegistrationService({
      store: f.store,
      fetchImpl: cardResponder({ name: "x" }),
      lookup: publicLookup,
    });

    await expect(
      svc.register({ tenantId: 1, agentId: "bad-agent", endpointUrl: "https://bad.example/" }),
    ).rejects.toMatchObject({ code: "invalid_card" });
    expect(f.agents).toHaveLength(0);
    expect(f.tokens).toHaveLength(0);
  });
});

describe("registration refresh", () => {
  const agent: GatewayAgentRecord = {
    tenantId: 1,
    agentId: "review-agent",
    displayName: "Codex Review Agent",
    endpointUrl: "https://review.acme.example/",
    card: validCard(),
    health: "healthy",
    cardFetchedAt: null,
    lastSeenAt: null,
  };

  it("marks an unreachable agent without losing its last known card", async () => {
    const f = fakeStore([agent]);
    const svc = createRegistrationService({
      store: f.store,
      lookup: publicLookup,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(await svc.refresh(agent)).toEqual({ health: "unreachable", changed: false });
    expect(f.agents[0].health).toBe("unreachable");
    expect(f.agents[0].card.skills[0].id).toBe("review.pr");
  });

  it("reports a changed card so the skill index gets rebuilt", async () => {
    const f = fakeStore([agent]);
    const next = { ...validCard(), skills: [{ id: "review.pr2", name: "n", description: "d" }] };
    const svc = createRegistrationService({
      store: f.store,
      lookup: publicLookup,
      fetchImpl: cardResponder(next),
    });

    expect(await svc.refresh(agent)).toEqual({ health: "healthy", changed: true });
    expect(f.agents[0].card.skills[0].id).toBe("review.pr2");
  });
});

describe("secretBox", () => {
  const key = parseSecretKey(randomBytes(32).toString("hex"));

  it("round-trips a credential", () => {
    const box = createAesSecretBox(key);
    const sealed = box.seal("s3cret-value");
    expect(box.open(sealed)).toBe("s3cret-value");
  });

  it("produces different ciphertext each time for the same input", () => {
    const box = createAesSecretBox(key);
    expect(box.seal("same").equals(box.seal("same"))).toBe(false);
  });

  it("never leaves the plaintext visible in the sealed bytes", () => {
    const box = createAesSecretBox(key);
    expect(box.seal("s3cret-value").toString("utf8")).not.toContain("s3cret");
  });

  it("refuses a value sealed under a different key", () => {
    const sealed = createAesSecretBox(key).seal("x");
    const other = createAesSecretBox(parseSecretKey(randomBytes(32).toString("hex")));
    expect(() => other.open(sealed)).toThrow(SecretBoxError);
  });

  it("detects tampering", () => {
    const box = createAesSecretBox(key);
    const sealed = box.seal("s3cret-value");
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => box.open(sealed)).toThrow(/wrong key or corrupt data/);
  });

  it("rejects a key that is not 32 bytes of hex", () => {
    expect(() => parseSecretKey("abc")).toThrow(SecretBoxError);
    expect(() => parseSecretKey("z".repeat(64))).toThrow(SecretBoxError);
  });
});

describe("token helpers", () => {
  it("mints tokens that are unguessable and prefixed", () => {
    const a = newAgentToken();
    expect(a.startsWith("fleet_")).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(newAgentToken()).not.toBe(a);
  });

  it("compares hashes in constant time without throwing on length mismatch", () => {
    expect(secureEquals("abc", "abc")).toBe(true);
    expect(secureEquals("abc", "abd")).toBe(false);
    expect(secureEquals("abc", "abcd")).toBe(false);
  });
});
