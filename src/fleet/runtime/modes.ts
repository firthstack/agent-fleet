export type FleetMode = "site";

/**
 * The gateway only runs one way. The mode switch survives from when this
 * process also hosted agents; it stays so that `--fleet-mode site` keeps
 * working and so a second server mode has somewhere to land.
 */
export function resolveFleetMode(
  env: Partial<Record<"FLEET_MODE", string>> = process.env,
  argv: readonly string[] = process.argv,
): FleetMode {
  const raw = (fleetModeFromArgs(argv) ?? env.FLEET_MODE)?.trim().toLowerCase();
  if (raw && raw !== "site") {
    throw new Error(`unsupported fleet mode: ${raw}`);
  }
  return "site";
}

function fleetModeFromArgs(argv: readonly string[]): string | undefined {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fleet-mode" || arg === "--mode") {
      const value = argv[i + 1]?.trim();
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      return value;
    }
    const match = /^--(?:fleet-)?mode=(.+)$/.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}
