// Derives the runtime pin and the frozen job's hashes for a runtime image. The frozen judge_verify
// job names the runtime image's digest, so a new runtime image changes the job's request and
// expected-trials hashes; this reads the frozen suite from a prepared store (checked against the
// pins first) and builds the job for the given runtime.
//
//   node packages/host-umami/src/pin-cli.ts --store <dir> --runtime-image <reference> \
//     --runtime-digest <sha256:...> --runtime-architecture <amd64|arm64> \
//     [--kit-image <reference> --kit-digest <sha256:...> --kit-sha256 <hex> --kit-architecture <amd64|arm64>]
//
// The kit options replace the kit pins for a store prepared from another build of the kit image,
// such as a local arm64 build for proofs. Prints { kit, runtime, job } as JSON. Exit 0 on success,
// 1 when the store is not the pins' (or the frozen suite is not the pinned one), 2 for a usage error.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Architecture } from "@rbw/factory-contract";
import { UmamiRefusal } from "./errors.ts";
import { suiteTestIds } from "./inputs.ts";
import { buildFrozenJob } from "./job.ts";
import { UMAMI_PINS } from "./pins.ts";
import type { UmamiPins, UmamiRuntimePin } from "./pins.ts";
import { openStore } from "./store.ts";

/** The runtime pin and the frozen job's hashes that pins with this runtime need. */
export async function runtimePins(pins: UmamiPins, store: string, runtime: UmamiRuntimePin): Promise<Pick<UmamiPins, "runtime" | "job">> {
  const prepared = await openStore(store, pins);
  const job = buildFrozenJob({ ...pins, runtime }, suiteTestIds(await prepared.read(prepared.index.original_suite.sha256)));
  return { runtime: { ...runtime }, job: { request_sha256: job.requestSha256, expected_trials_sha256: job.expectedSha256 } };
}

const USAGE =
  "usage: pin-cli.ts --store <dir> --runtime-image <ref> --runtime-digest <sha256:...> --runtime-architecture <amd64|arm64>\n" +
  "  [--kit-image <ref> --kit-digest <sha256:...> --kit-sha256 <hex> --kit-architecture <amd64|arm64>]\n";
const OPTIONS = {
  store: { type: "string" },
  "runtime-image": { type: "string" },
  "runtime-digest": { type: "string" },
  "runtime-architecture": { type: "string" },
  "kit-image": { type: "string" },
  "kit-digest": { type: "string" },
  "kit-sha256": { type: "string" },
  "kit-architecture": { type: "string" },
} as const;

type Values = Partial<Record<keyof typeof OPTIONS, string>>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function architecture(value: string | undefined): Architecture | null {
  return value === "amd64" || value === "arm64" ? value : null;
}

/** The pins and runtime the options name, or the usage problem. */
function fromOptions(values: Values): { pins: UmamiPins; store: string; runtime: UmamiRuntimePin } | string {
  const runtimeArchitecture = architecture(values["runtime-architecture"]);
  const { store } = values;
  const image = values["runtime-image"];
  const digest = values["runtime-digest"];
  if (store === undefined || image === undefined || digest === undefined || !DIGEST.test(digest) || runtimeArchitecture === null) {
    return "--store, --runtime-image, --runtime-digest (sha256:<64 hex>) and --runtime-architecture (amd64 or arm64) are required";
  }
  const kitOptions = [values["kit-image"], values["kit-digest"], values["kit-sha256"], values["kit-architecture"]];
  let { kit } = UMAMI_PINS;
  if (kitOptions.some((value) => value !== undefined)) {
    const [kitImage, kitDigest, kitSha256, kitArch] = kitOptions;
    const kitArchitecture = architecture(kitArch);
    if (kitImage === undefined || kitDigest === undefined || !DIGEST.test(kitDigest) || kitSha256 === undefined || !SHA256.test(kitSha256) || kitArchitecture === null) {
      return "the kit options go together: --kit-image, --kit-digest (sha256:<64 hex>), --kit-sha256 (64 hex) and --kit-architecture";
    }
    kit = { ...kit, image: kitImage, digest: kitDigest, kit_sha256: kitSha256, architecture: kitArchitecture };
  }
  return { pins: { ...UMAMI_PINS, kit }, store: resolve(store), runtime: { image, digest, architecture: runtimeArchitecture } };
}

/**
 * The options as given. The parser throws for an unknown option, a positional argument or an
 * option without its value; that is a usage error, so its reason comes back instead of the values.
 */
function readOptions(): { values: Values; reason: string | null } {
  try {
    return { values: parseArgs({ options: OPTIONS }).values, reason: null };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_"))) throw error;
    return { values: {}, reason: error.message };
  }
}

if (import.meta.main) {
  const { values, reason } = readOptions();
  const parsed = reason ?? fromOptions(values);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    try {
      const pinned = await runtimePins(parsed.pins, parsed.store, parsed.runtime);
      process.stdout.write(`${JSON.stringify({ kit: parsed.pins.kit, ...pinned }, null, 2)}\n`);
    } catch (error) {
      if (!(error instanceof UmamiRefusal)) throw error;
      process.stderr.write(`refused ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
