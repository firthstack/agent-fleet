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

  const server = createFleetSiteServer({
    store,
    publicBaseUrl,
    logger: log,
    workflows,
    workflowStarter: driver,
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
