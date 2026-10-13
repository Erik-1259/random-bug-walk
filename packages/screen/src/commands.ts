// The command line: `plan` (no network, no database) and `run` (metered calls).
// Exit codes: 0 done; 1 the run stopped, could not start or does not fit the budget; 2 bad usage.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { budgetRefusal, worstCasePerCall } from "./budget.ts";
import { loadSubject, parseScreenInput } from "./inputs.ts";
import type { ScreenSubject } from "./inputs.ts";
import { isScreenModelName, MAX_ATTEMPTS, SCREEN_PROFILES } from "./profiles.ts";
import type { ScreenModelName } from "./profiles.ts";
import { screenPrompt } from "./prompt.ts";
import { siteLabel } from "./site.ts";
import { DEFAULT_FAIL_AT_HITS } from "./score.ts";
import { executeScreen } from "./screen.ts";
import type { ScreenOptions } from "./screen.ts";

export const USAGE = `usage:
  node packages/screen/src/cli.ts plan --input <screen-input.json> --tree <planted tree> --clean <clean target file> --rate-sheet <rates.json> --attempts <1-${String(MAX_ATTEMPTS)}> --budget-microusd <n> [--model super|kimi]
  node packages/screen/src/cli.ts run  --input <screen-input.json> --tree <planted tree> --clean <clean target file> --rate-sheet <rates.json> --attempts <1-${String(MAX_ATTEMPTS)}> --budget-microusd <n> --out <new dir> --slot-key <key> --pool <pool-key> [--model super|kimi] [--fail-at-hits <n>] [--binding]`;

const OPTIONS = {
  input: { type: "string" },
  tree: { type: "string" },
  clean: { type: "string" },
  "rate-sheet": { type: "string" },
  attempts: { type: "string" },
  "budget-microusd": { type: "string" },
  model: { type: "string" },
  out: { type: "string" },
  "slot-key": { type: "string" },
  pool: { type: "string" },
  "fail-at-hits": { type: "string" },
  binding: { type: "boolean" },
} as const;

/** A decimal integer from `min` to `max`, or null. */
export function integerArg(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^[0-9]{1,16}$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

interface Common {
  subject: ScreenSubject;
  rateSheet: Uint8Array;
  attempts: number;
  budget: number;
  model: ScreenModelName;
}

type Parsed = { ok: true; values: Record<string, string | boolean | undefined>; common: Common } | { ok: false; code: number };

async function parseCommon(name: string, options: ScreenOptions): Promise<Parsed> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: options.argv, strict: true, allowPositionals: false, options: OPTIONS }).values;
  } catch {
    say(USAGE);
    return { ok: false, code: 2 };
  }
  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const input = str("input");
  const tree = str("tree");
  const clean = str("clean");
  const rates = str("rate-sheet");
  if (input === undefined || tree === undefined || clean === undefined || rates === undefined) {
    say(USAGE);
    return { ok: false, code: 2 };
  }
  const attempts = integerArg(str("attempts"), 1, MAX_ATTEMPTS);
  if (attempts === null) {
    say(`${name}: --attempts must be from 1 to ${String(MAX_ATTEMPTS)}`);
    return { ok: false, code: 2 };
  }
  const budget = integerArg(str("budget-microusd"), 1, Number.MAX_SAFE_INTEGER);
  if (budget === null) {
    say(`${name}: --budget-microusd must be a positive integer`);
    return { ok: false, code: 2 };
  }
  const model = str("model") ?? "super";
  if (!isScreenModelName(model)) {
    say(`${name}: --model must be super or kimi`);
    return { ok: false, code: 2 };
  }
  try {
    const parsed = parseScreenInput(JSON.parse(await readFile(input, "utf8")));
    const subject = await loadSubject(parsed, tree, clean);
    const rateSheet = await readFile(rates);
    return { ok: true, values, common: { subject, rateSheet, attempts, budget, model } };
  } catch (error) {
    say(`${name}: could not read the inputs: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok: false, code: 1 };
  }
}

/** Prints the site, the files shown, the prompt size and the budget check. Sends and reserves nothing. */
export async function runPlan(options: ScreenOptions): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  const parsed = await parseCommon("plan", options);
  if (!parsed.ok) {
    return parsed.code;
  }
  const { subject, rateSheet, attempts, budget, model } = parsed.common;
  const profile = SCREEN_PROFILES[model];
  const worst = worstCasePerCall(rateSheet, profile);
  if (!worst.ok) {
    say(`plan: unknown_price: ${worst.detail}`);
    return 1;
  }
  const prompt = screenPrompt(subject.input.symptom, subject.files);
  const promptBytes = Buffer.byteLength(prompt.system) + Buffer.byteLength(prompt.user);
  say(`plan: case ${subject.input.case}; planted site ${siteLabel(subject.input.target_path, subject.site)}`);
  say(`plan: files shown: ${subject.files.map((file) => file.path).join(", ")}`);
  say(`plan: prompt messages ${String(promptBytes)} bytes; per-call input limit ${String(profile.hashed.max_input_tokens)} tokens`);
  say(`plan: model ${profile.hashed.model}; worst case ${String(worst.per_call_microusd)} micro-USD per call, ${String(attempts * worst.per_call_microusd)} for ${String(attempts)} attempts; budget ${String(budget)}`);
  const refusal = budgetRefusal(attempts, worst.per_call_microusd, budget);
  if (refusal !== null) {
    say(`plan: over budget: ${refusal}`);
    return 1;
  }
  return 0;
}

export async function runScreen(options: ScreenOptions): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  const parsed = await parseCommon("run", options);
  if (!parsed.ok) {
    return parsed.code;
  }
  const { values, common } = parsed;
  const out = values.out;
  const slotKey = values["slot-key"];
  const pool = values.pool;
  if (typeof out !== "string" || out === "" || typeof slotKey !== "string" || slotKey === "" || typeof pool !== "string" || pool === "") {
    say(USAGE);
    return 2;
  }
  const failRaw = values["fail-at-hits"];
  const failAtHits = failRaw === undefined ? DEFAULT_FAIL_AT_HITS : integerArg(typeof failRaw === "string" ? failRaw : undefined, 1, common.attempts);
  if (failAtHits === null) {
    say(`run: --fail-at-hits must be from 1 to the number of attempts`);
    return 2;
  }
  const result = await executeScreen(options, {
    subject: common.subject,
    model: common.model,
    attempts: common.attempts,
    failAtHits,
    budgetMicrousd: common.budget,
    rateSheet: common.rateSheet,
    out,
    slotKey,
    pool,
    binding: values.binding === true,
  });
  return result.code;
}

/** Runs the subcommand named by the first argument, with the rest as its arguments. */
export async function runCommand(options: ScreenOptions): Promise<number> {
  const args = options.argv[0] === "--" ? options.argv.slice(1) : options.argv;
  const [command, ...rest] = args;
  const sub = { ...options, argv: rest };
  switch (command) {
    case "plan":
      return runPlan(sub);
    case "run":
      return runScreen(sub);
    default:
      options.write(`${USAGE}\n`);
      return 2;
  }
}
