import { Pool, type PoolConfig } from "pg";

export interface FleetDbOptions {
  connectionString: string;
  /**
   * Disable TLS certificate verification. Only for local/test Postgres that
   * speaks plaintext or serves a self-signed cert. InstaCloud's managed
   * Postgres presents a publicly verifiable cert, so production keeps
   * verification on.
   */
  insecureSsl?: boolean;
  max?: number;
}

/**
 * `agent-db` is scale-to-zero (`always_on: false`). When the instance
 * suspends, every connection the pool is holding is severed server-side, and
 * the next checkout hands out a dead socket. Two defences:
 *
 *   - `idleTimeoutMillis` well under the suspend window, so the pool has
 *     already let go of its connections before the server drops them;
 *   - a pool-level `error` listener, because an idle client erroring out
 *     otherwise reaches the process as an unhandled `error` event and kills
 *     the site.
 *
 * See docs/fleet-a2a-gateway.md §10.1. If the database is switched to
 * always-on these stay harmless.
 */
const IDLE_TIMEOUT_MS = 10_000;

export function fleetPoolConfig(opts: FleetDbOptions): PoolConfig {
  const plaintext =
    opts.insecureSsl === true || /\bsslmode=disable\b/.test(opts.connectionString);
  return {
    connectionString: opts.connectionString,
    ssl: plaintext ? false : { rejectUnauthorized: true },
    max: opts.max ?? 10,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    keepAlive: true,
  };
}

export function createFleetPool(opts: FleetDbOptions): Pool {
  const pool = new Pool(fleetPoolConfig(opts));
  // An idle client severed by a suspending database must not take the
  // process down; the pool discards it and the next checkout reconnects.
  pool.on("error", () => {});
  return pool;
}

export function fleetDatabaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the fleet site. Bind it with: " +
        "insta secrets bind DATABASE_URL postgres/agent-db --to compute/<site>",
    );
  }
  return url;
}
