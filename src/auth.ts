import { betterAuth } from "better-auth";
import { Pool } from "pg";

/**
 * Human identity. Agents authenticate with bearer tokens on `/a2a/*`; this is
 * the entirely separate axis for people on `/api/*` (docs/fleet-console.md §2).
 *
 * Better Auth is a library, not a hosted service: it runs in this process and
 * writes to the same Postgres as everything else. So its tables ride along in
 * our migration sequence, and its secret is ours to manage.
 *
 * Its tables are global — they carry no tenant_id — so they deliberately get
 * no RLS policy and no grant to `fleet_app`. A console request resolves the
 * user *before* switching into a tenant's security context.
 */

function ssl(connectionString: string) {
  return /\bsslmode=disable\b/.test(connectionString)
    ? false
    : { rejectUnauthorized: true };
}

export interface CreateAuthOptions {
  connectionString: string;
  baseURL?: string;
  /**
   * Called once per new user, inside Better Auth's own create hook. This is
   * where a tenant gets minted, so there is no window in which a signed-in
   * user has nowhere to put their agents.
   */
  onUserCreated?(user: { id: string; email: string; name?: string }): Promise<void>;
}

export function createAuth(opts: CreateAuthOptions) {
  const connectionString = opts.connectionString;
  return betterAuth({
    // User-visible: Better Auth puts it in the mail it sends. Kept in step
    // with the web app's PRODUCT_NAME by test/web/product.test.ts.
    appName: "Fleet",
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    basePath: "/api/auth",
    database: new Pool({ connectionString, ssl: ssl(connectionString), max: 4 }),
    emailAndPassword: { enabled: true },
    // Prefixed table names. The defaults are `user`, `session`, `account` and
    // `verification`: `user` is a reserved word in Postgres (so every query
    // has to quote it), and all four are generic enough to collide with
    // whatever else lands in this schema. `auth_*` beside our `fleet_*` also
    // says at a glance who owns what.
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          socialProviders: {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          },
        }
      : {}),
    // The SPA is served from the same origin, so this stays tight.
    trustedOrigins: (process.env.FLEET_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
    },
    ...(opts.onUserCreated
      ? {
          databaseHooks: {
            user: {
              create: {
                after: async (user: { id: string; email: string; name?: string }) => {
                  await opts.onUserCreated!(user);
                },
              },
            },
          },
        }
      : {}),
  });
}

/** The CLI needs a module-level `auth` export to read the schema from. */
export const auth = createAuth({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder?sslmode=disable",
});
