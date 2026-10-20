// The factory routes' server: test mode's deterministic fakes (RBW_FACTORY_TEST_MODE=1, loaded only
// then), or the live wiring (integration.ts). Test mode asked for in a production deployment is
// refused: every port answers `unavailable`, nobody can sign in, and the test endpoints answer not_found.
import { loadFactoryConfig, type FactoryConfig } from "../config.ts";
import { refuse } from "./http.ts";
import { liveServer } from "./integration.ts";
import type { FactoryServer, FactoryServerPorts } from "./ports.ts";

export class FactoryRefusedError extends Error {
  constructor() {
    super("factory test mode is refused in a production deployment");
    this.name = "FactoryRefusedError";
  }
}

function log(line: string): void {
  console.log(line);
}

/** The refusal is logged once per server process, not on every call. */
let refusalLogged = false;

function refusedServer(): FactoryServer {
  const refused = (): never => {
    throw new FactoryRefusedError();
  };
  const ports: FactoryServerPorts = {
    now: () => new Date(),
    passcode: null,
    get profile(): FactoryServerPorts["profile"] {
      return refused();
    },
    capabilities: refused,
    interpret: refused,
    canonicalStart: refused,
    withRequestLock: refused,
    findRequest: refused,
    ledgerState: refused,
    poolAvailable: refused,
    acquireSlot: refused,
    slotHolder: refused,
    releaseSlot: refused,
    createRecordLaunch: refused,
    status: refused,
    noteUnresponsive: refused,
    recordStop: refused,
    finalizeLost: refused,
    findValidation: refused,
    startValidation: refused,
    getValidation: refused,
    readPackage: refused,
    example: refused,
  };
  return { ports, requestRoot: refused, test: null, log };
}

export async function factoryServer(config: FactoryConfig = loadFactoryConfig()): Promise<FactoryServer> {
  switch (config.mode) {
    case "test": {
      const { testModeServer } = await import("./test-mode/world.ts");
      return testModeServer(config, log);
    }
    case "refused":
      if (!refusalLogged) log("factory: RBW_FACTORY_TEST_MODE is refused when VERCEL_ENV is production; every factory port answers unavailable and nobody can sign in");
      refusalLogged = true;
      return refusedServer();
    case "live":
      return liveServer(config, log);
  }
}

/** Runs a route's handler; a server that cannot be built (for example, missing test fixtures) answers unavailable. */
export async function handle(run: (server: FactoryServer) => Response | Promise<Response>): Promise<Response> {
  let server: FactoryServer;
  try {
    server = await factoryServer();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    log(`factory: the server could not be built (${error.name}); answered unavailable`);
    return refuse("unavailable");
  }
  return run(server);
}
