// Prepares the store on a host with Docker:
//
//   node packages/host-umami/src/prepare-cli.ts --image <kit image> --dest <new dir> \
//     --original-suite <frozen original-suite.json> --incident <released issue.json>
//
// Prints the store's index SHA-256. Exit 0 on success, 1 when an input is not the pinned one,
// 2 for a usage error: a missing or unknown option, an option without its value or a positional
// argument.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDocker } from "@rbw/local-runner";
import { UmamiRefusal } from "./errors.ts";
import { prepareStore } from "./prepare.ts";

const USAGE = "usage: prepare-cli.ts --image <ref> --dest <dir> --original-suite <file> --incident <file>\n";
const OPTIONS = { image: { type: "string" }, dest: { type: "string" }, "original-suite": { type: "string" }, incident: { type: "string" } } as const;

type Values = Partial<Record<keyof typeof OPTIONS, string>>;

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
  const { image, dest, incident } = values;
  const originalSuite = values["original-suite"];
  if (image === undefined || dest === undefined || originalSuite === undefined || incident === undefined) {
    process.stderr.write(reason === null ? USAGE : `${reason}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const work = await mkdtemp(join(tmpdir(), "rbw-host-umami-prepare-"));
    const container = `rbw-host-umami-prepare-${work.slice(-6).toLowerCase()}`;
    try {
      const result = await prepareStore(createDocker(), { image, dest: resolve(dest), work, originalSuite: resolve(originalSuite), incident: resolve(incident), container });
      process.stdout.write(`index_sha256=${result.index_sha256}\nstore=${result.dir}\n`);
    } catch (error) {
      if (!(error instanceof UmamiRefusal)) throw error;
      process.stderr.write(`refused ${error.message}\n`);
      process.exitCode = 1;
    } finally {
      // The work directory holds only the exported source; the store is written under --dest.
      await rm(work, { recursive: true, force: true });
    }
  }
}
