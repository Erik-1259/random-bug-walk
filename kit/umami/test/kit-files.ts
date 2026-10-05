// Readers for the kit's committed files, shared by the static tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const kitRoot = fileURLToPath(new URL("..", import.meta.url));

export function readKitFile(relativePath: string): string {
  return readFileSync(`${kitRoot}/${relativePath}`, "utf8");
}

export interface Instruction {
  keyword: string;
  args: string;
  /** Comment lines directly above the instruction, without the leading "#". */
  comments: string[];
  stage: string;
}

/** Splits a Dockerfile into instructions, joining continuation lines and tracking the stage name. */
export function parseDockerfile(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let comments: string[] = [];
  let pending = "";
  let stage = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (pending === "" && trimmed.startsWith("#")) {
      comments.push(trimmed.slice(1).trim());
      continue;
    }
    if (pending === "" && trimmed === "") {
      comments = [];
      continue;
    }
    if (pending !== "" && trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.endsWith("\\")) {
      pending += `${trimmed.slice(0, -1).trim()} `;
      continue;
    }
    const full = `${pending}${trimmed}`.trim();
    pending = "";
    const match = /^([A-Za-z]+)\s+(.*)$/s.exec(full);
    if (match === null) {
      throw new Error(`unparseable Dockerfile line: ${full}`);
    }
    const keyword = (match[1] ?? "").toUpperCase();
    const args = match[2] ?? "";
    if (keyword === "FROM") {
      stage = /\s+AS\s+(\S+)\s*$/i.exec(args)?.[1] ?? "";
    }
    instructions.push({ keyword, args, comments, stage });
    comments = [];
  }
  return instructions;
}

/** Returns the default value of every ARG, keyed by name; later declarations without a value keep the first default. */
export function argDefaults(instructions: Instruction[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const instruction of instructions) {
    if (instruction.keyword !== "ARG") {
      continue;
    }
    const [name, value] = instruction.args.split("=", 2);
    if (name !== undefined && value !== undefined && !defaults.has(name)) {
      defaults.set(name, value.replace(/^"|"$/g, ""));
    }
  }
  return defaults;
}

/** Defers a computation to first use and caches it, so a missing file fails only the tests that need it. */
export function memo<T>(compute: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: compute() };
    return cached.value;
  };
}
