// Live mode: the factory ports over the real modules (live/), loaded only here, so test mode never
// loads the ledger driver, the worker launch or the package tooling. live/runtime.ts builds the
// dependencies from the configuration once per process; live/server.ts maps every port to the spend
// ledger, the factory core, the worker and the prepared packages. Without DATABASE_URL, or with an
// incomplete worker launch configuration, capabilities show not_configured and every other port that
// needs the ledger or the launch answers `unavailable`; the session works, and the completed example
// answers 404 while none is published.
import type { FactoryConfig } from "../config.ts";
import type { FactoryServer } from "./ports.ts";

export async function liveServer(config: FactoryConfig, log: (line: string) => void): Promise<FactoryServer> {
  const { liveServerFor } = await import("./live/runtime.ts");
  return liveServerFor(config, log);
}
