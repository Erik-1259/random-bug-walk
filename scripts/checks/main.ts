// Shared entry point for the check scripts: 0 pass, 1 violation, 2 the check cannot run.
// Any unexpected error becomes exit 2, so a crash can never read as a pass or a violation.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MainOptions {
  /** Print only a generic reason, for checks whose error text could carry scanned content. */
  genericErrors?: boolean;
}

/**
 * True when the module is the process entry point. Node releases that run .ts files but predate
 * import.meta.main leave it undefined; comparing the entry path keeps the check running there
 * instead of exiting 0 without checking anything.
 */
export function isEntryPoint(meta: { url: string; main?: boolean }, entry: string | undefined = process.argv[1]): boolean {
  if (typeof meta.main === "boolean") {
    return meta.main;
  }
  if (entry === undefined) {
    return false;
  }
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(resolve(entry)) === real(fileURLToPath(meta.url));
}

export function runMain(name: string, main: () => number, options: MainOptions = {}): void {
  try {
    process.exitCode = main();
  } catch (error) {
    const reason = options.genericErrors === true || !(error instanceof Error) ? "internal error" : error.message;
    process.stderr.write(`${name}: cannot run: ${reason}\n`);
    process.exitCode = 2;
  }
}
