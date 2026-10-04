// Stand-in for the publication scanner CLI, used only by tests and container proofs.
// With SYNTHETIC_STANDIN_PRESET it replays a preset outcome; otherwise it runs a minimal
// case-insensitive literal-term scan over the same inputs as the real scanner.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Preset {
  stdout?: string;
  stderr?: string;
  exit?: number;
  crash?: boolean;
  sleepMs?: number;
}

function optionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    const value = args[index + 1];
    if (arg === name && value !== undefined) {
      values.push(value);
    }
  });
  return values;
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed`);
  }
  return result.stdout;
}

function matchingLines(text: string, terms: readonly string[]): number[] {
  const found: number[] = [];
  text.split(/\r\n|\n|\r/).forEach((line, index) => {
    const lower = line.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      found.push(index + 1);
    }
  });
  return found;
}

function literalScan(args: readonly string[]): number {
  const patternFile = optionValues(args, "--patterns")[0];
  const terms =
    patternFile === undefined
      ? []
      : readFileSync(patternFile, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter((line) => line !== "" && !line.startsWith("#"));
  if (terms.length === 0) {
    process.stdout.write("unavailable\n");
    return 2;
  }
  const locations: string[] = [];
  const range = optionValues(args, "--range")[0];
  if (range !== undefined) {
    const commits = gitOutput(["rev-list", "--reverse", range]).split("\n").filter(Boolean);
    for (const commit of commits) {
      const short = commit.slice(0, 12);
      const message = gitOutput(["log", "-1", "--format=%B", commit]);
      for (const line of matchingLines(message, terms)) {
        locations.push(`commit-${short}:${String(line)}`);
      }
      const paths = gitOutput(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-filter=AM", commit])
        .split("\n")
        .filter(Boolean);
      for (const line of matchingLines(paths.join("\n"), terms)) {
        locations.push(`paths-${short}:${String(line)}`);
      }
      for (const path of paths) {
        for (const line of matchingLines(gitOutput(["show", `${commit}:${path}`]), terms)) {
          locations.push(`${path}:${String(line)}`);
        }
      }
    }
  }
  for (const text of optionValues(args, "--text")) {
    const separator = text.indexOf("=");
    const name = text.slice(0, separator);
    for (const line of matchingLines(readFileSync(text.slice(separator + 1), "utf8"), terms)) {
      locations.push(`${name}:${String(line)}`);
    }
  }
  if (locations.length === 0) {
    process.stdout.write("clean\n");
    return 0;
  }
  process.stdout.write(`blocked\n${locations.join("\n")}\n`);
  return 1;
}

function replay(preset: Preset): number {
  if (preset.sleepMs !== undefined) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, preset.sleepMs);
  }
  if (preset.stderr !== undefined) {
    process.stderr.write(preset.stderr);
  }
  if (preset.stdout !== undefined) {
    process.stdout.write(preset.stdout);
  }
  if (preset.crash === true) {
    process.abort();
  }
  return preset.exit ?? 0;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args[0] === "gitleaks-version") {
    process.stdout.write("8.30.1\n");
    return 0;
  }
  const recordPath = process.env.SYNTHETIC_STANDIN_RECORD;
  if (recordPath !== undefined) {
    const texts = Object.fromEntries(
      optionValues(args, "--text").map((text) => {
        const separator = text.indexOf("=");
        return [text.slice(0, separator), readFileSync(text.slice(separator + 1), "utf8")];
      }),
    );
    writeFileSync(recordPath, JSON.stringify({ args, texts }));
  }
  const presetPath = process.env.SYNTHETIC_STANDIN_PRESET;
  if (presetPath !== undefined) {
    return replay(JSON.parse(readFileSync(presetPath, "utf8")) as Preset);
  }
  return literalScan(args);
}

process.exitCode = main();
