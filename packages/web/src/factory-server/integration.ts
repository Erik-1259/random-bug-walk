// HELD: the live wiring of the factory ports to the other packages' real modules. They are not in this
// tree yet, so every port that needs one throws FactoryNotWiredError, which the handlers answer as
// `unavailable`. Only the clock, the passcode and the completed example (none is published yet, so
// 404) work without them. One integration pass replaces each stub below with its real function:
// - the spend ledger's budget, lock and factory-record functions: withRequestLock, findRequest,
//   ledgerState, poolAvailable, acquireSlot, releaseSlot, recordStop, findValidation;
// - the request loop's interpreter, capability builder, identity and projection: capabilities,
//   interpret, canonicalStart, status, requestRoot;
// - the worker's frozen factory profile, launch, validation and lost-worker functions: profile,
//   createRecordLaunch (with the ledger's budget and record), startValidation, getValidation,
//   finalizeLost;
// - the package tooling's host registry and archive reads, with the ledger's evidence read: readPackage.
// Two ports were added after the first port list and have no supplier yet:
// - `slotHolder`: the ledger's slot status read, plus a lookup from the holder's root to its request
//   or validation run, which no ledger read offers yet;
// - `noteUnresponsive`: a keyed `attention` worker_unresponsive event once the worker sent no
//   heartbeat for 60 s, and a keyed `attention_cleared` once one arrives, appended through the
//   ledger's factory records. The contract appends an event for each attention change, and a worker
//   that stopped responding cannot append its own, so this design appends it on the status side. A
//   status projection that also derives this attention from the clock would show it twice.
// Also held for that pass: a test that runs a copy record's evaluator fields through the real
// projection into every response. The handlers check each body's shape only (no unknown field).
import type { FactoryConfig } from "../config.ts";
import type { FactoryServer, FactoryServerPorts } from "./ports.ts";

export class FactoryNotWiredError extends Error {
  readonly port: string;

  constructor(port: string) {
    super(`factory port ${port} is not wired yet`);
    this.name = "FactoryNotWiredError";
    this.port = port;
  }
}

/** The ports that still throw FactoryNotWiredError in live mode, and requestRoot. */
export const HELD_PORTS = [
  "profile",
  "capabilities",
  "interpret",
  "canonicalStart",
  "withRequestLock",
  "findRequest",
  "ledgerState",
  "poolAvailable",
  "acquireSlot",
  "slotHolder",
  "releaseSlot",
  "createRecordLaunch",
  "status",
  "noteUnresponsive",
  "recordStop",
  "finalizeLost",
  "findValidation",
  "startValidation",
  "getValidation",
  "readPackage",
  "requestRoot",
] as const;

type Held = (typeof HELD_PORTS)[number];

function held(port: Held): never {
  throw new FactoryNotWiredError(port);
}

/** Live mode: the real ports where they exist, FactoryNotWiredError everywhere else. */
export function liveServer(config: FactoryConfig, log: (line: string) => void): FactoryServer {
  const ports: FactoryServerPorts = {
    now: () => new Date(),
    passcode: config.passcode,
    get profile(): FactoryServerPorts["profile"] {
      return held("profile");
    },
    capabilities: () => held("capabilities"),
    interpret: () => held("interpret"),
    canonicalStart: () => held("canonicalStart"),
    withRequestLock: () => held("withRequestLock"),
    findRequest: () => held("findRequest"),
    ledgerState: () => held("ledgerState"),
    poolAvailable: () => held("poolAvailable"),
    acquireSlot: () => held("acquireSlot"),
    slotHolder: () => held("slotHolder"),
    releaseSlot: () => held("releaseSlot"),
    createRecordLaunch: () => held("createRecordLaunch"),
    status: () => held("status"),
    noteUnresponsive: () => held("noteUnresponsive"),
    recordStop: () => held("recordStop"),
    finalizeLost: () => held("finalizeLost"),
    findValidation: () => held("findValidation"),
    startValidation: () => held("startValidation"),
    getValidation: () => held("getValidation"),
    readPackage: () => held("readPackage"),
    example: () => Promise.resolve(null),
  };
  return { ports, requestRoot: () => held("requestRoot"), test: null, log };
}
