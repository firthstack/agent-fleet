export interface FleetConfig {
  port: number;
  /** How many workflow runs one tenant may have in flight at once. */
  maxConcurrentRunsPerTenant: number;
}

/**
 * Gateway configuration.
 *
 * The SQLite path, admin user, password hash and session secret that used to
 * live here went with the mailbox site and its admin UI (docs §11.1). The
 * database now comes from `DATABASE_URL` (see ./db.ts) and the public origin
 * from `FLEET_PUBLIC_BASE_URL` (see ./server.ts); keeping the old required
 * vars here would block startup on values nothing reads.
 *
 * The tenant-facing admin UI (docs §11.3 step 6) will reintroduce its own
 * session config when it lands.
 */
export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  const portRaw = env.FLEET_PORT?.trim() || env.PORT?.trim() || "8790";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`FLEET_PORT must be a valid TCP port, got ${portRaw}`);
  }
  const limitRaw = env.FLEET_MAX_CONCURRENT_RUNS_PER_TENANT?.trim() || "10";
  const maxConcurrentRunsPerTenant = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(maxConcurrentRunsPerTenant) || maxConcurrentRunsPerTenant < 1) {
    throw new Error(
      "FLEET_MAX_CONCURRENT_RUNS_PER_TENANT must be a positive integer, got " +
        limitRaw,
    );
  }

  return { port, maxConcurrentRunsPerTenant };
}
