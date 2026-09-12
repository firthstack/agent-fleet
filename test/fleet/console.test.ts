import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../../src/fleet/site/gatewayStore.js";
import { createFleetSiteServer } from "../../src/fleet/site/server.js";
import { createConsoleHandler } from "../../src/fleet/console/api.js";
import { createAuth } from "../../src/auth.js";

/**
 * Sign-up through to a usable tenant, against a real Postgres and over real
 * HTTP. The thing worth proving is the seam: Better Auth owns the user, we
 * own the tenant, and the two are joined in the user-create hook so nobody is
 * ever signed in with nowhere to put their agents.
 */

const EXTERNAL_URL = process.env.FLEET_TEST_DATABASE_URL?.trim();

let container: StartedTestContainer | undefined;
let store: GatewayStore;
let server: Server | undefined;
let base = "";

process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("base64url");

beforeAll(async () => {
  let connectionString = EXTERNAL_URL;
  if (!connectionString) {
    container = await new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_USER: "admin",
        POSTGRES_PASSWORD: "admin",
        POSTGRES_DB: "fleet_test",
      })
      .withExposedPorts(5432)
      .start();
    connectionString = `postgres://admin:admin@${container.getHost()}:${container.getMappedPort(
      5432,
    )}/fleet_test?sslmode=disable`;
  }

  store = new GatewayStore({ connectionString, insecureSsl: !EXTERNAL_URL });
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await store.migrate(await readFile(`migrations/${file}`, "utf8"));
  }

  // Bind first so the auth baseURL matches the address we actually serve on;
  // Better Auth checks the origin.
  const probe = createFleetSiteServer({ store, publicBaseUrl: "http://127.0.0.1:1" });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  probe.close();
  base = `http://127.0.0.1:${port}`;

  const auth = createAuth({
    connectionString: connectionString!,
    baseURL: base,
    onUserCreated: async (user) => {
      await store.ensureTenantForUser(user);
    },
  });

  server = createFleetSiteServer({
    store,
    publicBaseUrl: base,
    console: createConsoleHandler({ auth, store, origin: base }),
  });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
}, 180_000);

afterAll(async () => {
  server?.close();
  await store?.close();
  await container?.stop();
});

beforeEach(async () => {
  await store.migrate(
    `TRUNCATE tenants, fleet_tenant_members, auth_user, auth_session,
              auth_account, auth_verification RESTART IDENTITY CASCADE`,
  );
});

/** Sign up and return the session cookie the browser would keep. */
async function signUp(email: string, password = "correct-horse-battery") {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password, name: email.split("@")[0] }),
  });
  const cookies = res.headers.getSetCookie();
  return { res, cookie: cookies.map((c) => c.split(";")[0]).join("; ") };
}

async function me(cookie: string) {
  const res = await fetch(`${base}/api/me`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}

describe("sign-up mints a tenant", () => {
  it("returns a session and a tenant the user owns", async () => {
    const { res, cookie } = await signUp("ada@example.com");
    expect(res.status).toBe(200);
    // Folding multiple set-cookie headers into one string is what breaks
    // sign-in silently, so assert we actually got a usable cookie.
    expect(cookie).not.toBe("");

    const out = await me(cookie);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      user: { email: "ada@example.com" },
      tenant: { slug: "ada" },
    });
  });

  it("derives the slug from the email's local part", async () => {
    const { cookie } = await signUp("Grace.Hopper+fleet@example.com");
    const out = await me(cookie);
    // The slug lands in every gateway URL, so it has to be URL-safe.
    expect((out.body as { tenant: { slug: string } }).tenant.slug).toMatch(
      /^[a-z0-9-]+$/,
    );
  });

  it("gives two people with the same local part different tenants", async () => {
    // "admin@a.com" and "admin@b.com" are both plausible, and a slug
    // collision would put one tenant's agents in the other's URLs.
    const first = await signUp("admin@acme.example");
    const second = await signUp("admin@globex.example");

    const a = (await me(first.cookie)).body as { tenant: { slug: string } };
    const b = (await me(second.cookie)).body as { tenant: { slug: string } };
    expect(a.tenant.slug).toBe("admin");
    expect(b.tenant.slug).toBe("admin-2");
  });

  it("keeps the same tenant across sign-out and sign-in", async () => {
    const { cookie } = await signUp("ada@example.com");
    const before = (await me(cookie)).body as { tenant: { slug: string } };

    const again = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        email: "ada@example.com",
        password: "correct-horse-battery",
      }),
    });
    const cookie2 = again.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const after = (await me(cookie2)).body as { tenant: { slug: string } };

    expect(after.tenant.slug).toBe(before.tenant.slug);
  });
});

describe("the console refuses anonymous callers", () => {
  it("answers 401 with no session", async () => {
    const res = await fetch(`${base}/api/me`);
    expect(res.status).toBe(401);
  });

  it("answers 401 for a forged cookie", async () => {
    const out = await me("better-auth.session_token=not-a-real-token");
    expect(out.status).toBe(401);
  });

  it("rejects a weak password rather than creating a tenant", async () => {
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "x@example.com", password: "x", name: "x" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // A failed sign-up must leave nothing behind — the tenant is minted in
    // the user-create hook, so a half-created user would strand one.
    // Not tenant-scoped: an RLS-filtered count would read 0 no matter what
    // and the assertion would prove nothing.
    expect(await store.countRows("tenants")).toBe(0);
  });
});

describe("surface separation", () => {
  it("does not accept a session cookie on the machine surface", async () => {
    const { cookie } = await signUp("ada@example.com");
    // /a2a/* is bearer-only on purpose (docs §3.1): accepting cookies there
    // would give the machine surface a CSRF face it never needed.
    const res = await fetch(`${base}/a2a/t/ada/catalog`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it("answers 404 for an unknown console route rather than falling through", async () => {
    const { cookie } = await signUp("ada@example.com");
    const res = await fetch(`${base}/api/nope`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});
