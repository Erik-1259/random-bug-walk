// The copy driver's command line in evaluator v2 (see v2/copy.ts), parsed apart from the driver so
// the host side can read a copy plan's command without loading the check. Imports only node:
// built-ins.
import { parseArgs } from "node:util";
import { STATES } from "../src/f3/data.ts";
import type { CodeState } from "../src/f3/data.ts";

export const COPY_ID = /^f3q2-[a-z0-9][a-z0-9-]{0,58}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CopyArgsV2 {
  state: CodeState;
  purpose: "counted" | "smoke";
  copyId: string;
  entryId: string;
  instances: number | null;
  mainTarget: number | null;
  controlTarget: number | null;
}

export class UsageError extends Error {
  override name = "UsageError";
}

function positive(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]?$/.test(value)) throw new UsageError(`${name} must be 1-99`);
  return Number(value);
}

export function parseCopyArgsV2(argv: readonly string[]): CopyArgsV2 {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        state: { type: "string" },
        purpose: { type: "string" },
        "copy-id": { type: "string" },
        entry: { type: "string" },
        instances: { type: "string" },
        "main-target": { type: "string" },
        "control-target": { type: "string" },
      },
    }));
  } catch {
    throw new UsageError("unknown or malformed argument");
  }
  const state = STATES.find((item) => item === values.state);
  if (state === undefined) throw new UsageError("--state must be clean, buggy or fixed");
  const purpose = values.purpose ?? "counted";
  if (purpose !== "counted" && purpose !== "smoke") throw new UsageError("--purpose must be counted or smoke");
  const copyId = values["copy-id"] ?? "";
  if (!COPY_ID.test(copyId)) throw new UsageError("--copy-id must start with f3q2- and use lowercase letters, digits and dashes");
  const entryId = values.entry ?? "";
  if (!ENTRY_ID.test(entryId)) throw new UsageError("--entry must name a catalog entry");
  const args: CopyArgsV2 = {
    state,
    purpose,
    copyId,
    entryId,
    instances: positive(values.instances, "--instances"),
    mainTarget: positive(values["main-target"], "--main-target"),
    controlTarget: positive(values["control-target"], "--control-target"),
  };
  if (purpose === "counted" && (args.instances !== null || args.mainTarget !== null || args.controlTarget !== null)) {
    throw new UsageError("a counted copy runs the protocol's counts; overrides are for smoke copies only");
  }
  if (purpose === "smoke" && state !== "clean") throw new UsageError("smoke copies run the clean state only");
  return args;
}
