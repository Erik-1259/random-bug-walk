// The pre-write scan hook for `case-package prepare --scan-hook`: runs the full publication scan (the
// private pattern list, the attribution rules and gitleaks) over every member of one package part.
//   RBW_SCAN_PATTERNS=<pattern file> RBW_GITLEAKS_COMMAND=<gitleaks command> \
//     node tools/case-package/src/cli.ts prepare ... --scan-hook tools/publication/src/prepare-scan-hook.ts
// Both settings come only from the environment, so nothing private is committed; without either one the
// hook answers `unavailable`. It prints nothing and answers with locations only, never matched text.
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GITLEAKS_COMMAND_VARIABLE } from "./config.ts";
import { isSafeRelativePath } from "./gitleaks.ts";
import { scan, type ScanResult } from "./scan.ts";

/** Environment variable that names the private pattern file. */
export const PATTERN_FILE_VARIABLE = "RBW_SCAN_PATTERNS";
export { GITLEAKS_COMMAND_VARIABLE };

/** One part as `case-package` hands it over (its ScanInput); kept structural so this package depends on nothing. */
export interface PreparedPart {
  part: string;
  members: readonly { path: string; bytes: Uint8Array }[];
}

const UNAVAILABLE: ScanResult = { outcome: "unavailable" };

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === "" ? null : value;
}

function isPart(input: unknown): input is PreparedPart {
  if (typeof input !== "object" || input === null) return false;
  const { part, members } = input as { part?: unknown; members?: unknown };
  return (
    typeof part === "string" &&
    Array.isArray(members) &&
    members.length > 0 &&
    members.every(
      (member: unknown) =>
        typeof member === "object" &&
        member !== null &&
        typeof (member as { path?: unknown }).path === "string" &&
        (member as { bytes?: unknown }).bytes instanceof Uint8Array,
    )
  );
}

/** Writes each member as a new regular file under `root`; an unsafe path or one that already exists throws. */
async function writeMembers(root: string, members: PreparedPart["members"]): Promise<void> {
  for (const member of members) {
    if (!isSafeRelativePath(member.path)) throw new Error("unsafe member path");
    const target = join(root, ...member.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(member.bytes);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Scans one part with the settings in `env`. The members are written to a new temporary directory and
 * scanned in files mode, so a finding is reported as `<member path>:<line>` (or `paths:<n>` for a path
 * that is itself a violation). Answers `unavailable` when a setting is missing, the input is malformed or
 * anything fails; never throws.
 */
export async function scanPreparedPart(input: unknown, env: NodeJS.ProcessEnv): Promise<ScanResult> {
  const patternFile = setting(env, PATTERN_FILE_VARIABLE);
  const gitleaksCommand = setting(env, GITLEAKS_COMMAND_VARIABLE);
  if (patternFile === null || gitleaksCommand === null || !isPart(input)) return UNAVAILABLE;
  let root: string | null = null;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "rbw-prepare-scan-")));
    await writeMembers(root, input.members);
    return await scan({ patternFile, gitleaksCommand, files: { root, paths: input.members.map((member) => member.path) } });
  } catch {
    return UNAVAILABLE;
  } finally {
    if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The hook `case-package prepare --scan-hook` loads; it reads its settings from the process environment. */
export const SCAN_HOOK = (input: PreparedPart): Promise<ScanResult> => scanPreparedPart(input, process.env);
