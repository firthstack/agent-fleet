import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { createLogger } from "./logger.js";
import { resolveFleetMode } from "./fleet/runtime/modes.js";
import { loadFleetConfig } from "./fleet/site/config.js";
import { GatewayStore } from "./fleet/site/gatewayStore.js";
import { fleetDatabaseUrlFromEnv } from "./fleet/site/db.js";
import { fleetSecretBoxFromEnv } from "./fleet/site/secretBox.js";
import { createA2AClient } from "./fleet/site/a2aClient.js";
import { hashToken } from "./fleet/site/registration.js";
import {
  createFleetSiteServer,
  fleetPublicBaseUrlFromEnv,
  startFleetWorkers,
} from "./fleet/site/server.js";
import { createWorkflowDriver } from "./fleet/workflow/driver.js";
import { createWorkflowDispatcher } from "./fleet/workflow/dispatcher.js";
import { createAuth } from "./auth.js";
import { createConsoleHandler } from "./fleet/console/api.js";

dotenv.config();

const log = createLogger();

async function main(): Promise<void> {
  resolveFleetMode();

  const cfg = loadFleetConfig();
  const store = new GatewayStore({
    connectionString: fleetDatabaseUrlFromEnv(),
    secretBox: fleetSecretBoxFromEnv(),
  });
  const publicBaseUrl = fleetPublicBaseUrlFromEnv();

  // The composition layer reuses the gateway's dispatch, claim queue and
  // deadline sweep rather than running machinery of its own.
  const workflows = store.workflows();
  const driver = createWorkflowDriver({
    store: workflows,
    logger: log,
    dispatcher: createWorkflowDispatcher({
      store,
      client: createA2AClient(),
      publicBaseUrl,
      newUpstreamTaskId: () => randomBytes(16).toString("hex"),
      newCallbackToken: () => randomBytes(32).toString("base64url"),
      hashToken,
    }),
  });

  // Human identity, entirely separate from the agent tokens on /a2a/*.
  // The tenant is minted inside the user-create hook, so nobody is ever
  // signed in with nowhere to put their agents.
  const auth = createAuth({
    connectionString: fleetDatabaseUrlFromEnv(),
    baseURL: publicBaseUrl,
    onUserCreated: async (user) => {
      const tenant = await store.ensureTenantForUser(user);
      log.info({ userId: user.id, tenant: tenant.slug }, "tenant created for new user");
    },
  });

  const server = createFleetSiteServer({
    store,
    publicBaseUrl,
    logger: log,
    workflows,
    workflowStarter: driver,
    // Built by `vite build`; absent in a dev run, which just means the API
    // is served without the console.
    webRoot: process.env.FLEET_WEB_ROOT?.trim() || "dist/web",
    console: createConsoleHandler({
      auth,
      store,
      origin: publicBaseUrl,
      logger: log,
    }),
  });
  const workers = startFleetWorkers({ store, workflowDriver: driver, logger: log });

  await new Promise<void>((resolve) => server.listen(cfg.port, "0.0.0.0", resolve));
  log.info({ port: cfg.port, publicBaseUrl }, "fleet gateway listening");

  const shutdown = () => {
    workers.stop();
    server.close();
    void store.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error({ err, error: err instanceof Error ? err.message : String(err) }, "fleet gateway failed to start");
  process.exit(1);
});
