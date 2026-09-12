import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/**
 * A Postgres container that is actually ready when `start()` resolves.
 *
 * The default wait strategy is satisfied as soon as the port accepts a
 * connection — but the official image starts Postgres once to run its init
 * scripts, shuts it down, and starts it again. A suite that connects in that
 * window gets `the database system is starting up`, or has its connection cut
 * out from under it by the restart (`terminating connection due to
 * administrator command`, code 57P01). That was the source of the
 * intermittent failures across every container-backed suite here.
 *
 * Waiting for the *second* "ready to accept connections" is what distinguishes
 * the real startup from the init one.
 */
export async function startPostgres(): Promise<{
  container: StartedTestContainer;
  connectionString: string;
}> {
  const container = await new GenericContainer("postgres:16")
    .withEnvironment({
      POSTGRES_USER: "admin",
      POSTGRES_PASSWORD: "admin",
      POSTGRES_DB: "fleet_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();

  return {
    container,
    connectionString: `postgres://admin:admin@${container.getHost()}:${container.getMappedPort(
      5432,
    )}/fleet_test?sslmode=disable`,
  };
}
