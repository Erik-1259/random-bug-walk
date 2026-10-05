// The `record` command: one live card call and one live issue call (at most two), each counted,
// reserved, launched, settled and written out as a recording plus a summary. The owner runs it in
// a private workflow; tests run the same wiring with a replay fetch and PGlite.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Spend } from "@rbw/spend";
import { z } from "zod";
import { ACTOR_ROLE, API_KEY_VARIABLE } from "./config.ts";
import type { FetchFunction } from "./http.ts";
import { parseRunContext } from "./identity.ts";
import type { RunContext } from "./identity.ts";
import { buildEnvelope, parseRateSheet } from "./rates.ts";
import { makeRecording, serializeRecording } from "./recording.ts";
import { WriterInterruptedError, createWriter, createWriterProvider } from "./writer.ts";
import type { CallRecord, CardOutcome, IssueOutcome } from "./writer.ts";

export const MAX_RECORD_CALLS = 2;

export interface RecordOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch: FetchFunction;
  provenance: "synthetic" | "live";
  /** Opens the spend database named by DATABASE_URL. */
  connect: (databaseUrl: string) => Promise<{ spend: Spend; close: () => Promise<void> }>;
  write: (text: string) => void;
  now: () => Date;
}

const USAGE =
  "usage: record --context <run-context.json> --rate-sheet <rates.json> --input <inputs.json> --out <dir> --slot-key <key> --pool <pool-key> --max-calls <1|2>";

const InputsSchema = z
  .object({
    candidate: z.string(),
    card: z.unknown(),
    issue: z.object({ symptom: z.unknown(), excluded_identifiers: z.array(z.string()) }).strict(),
  })
  .strict();

/** A driver error code such as ECONNREFUSED or a SQLSTATE; never a message, which can name the host or user. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
  }
  return "unknown";
}

/** Reads --max-calls on its own, before any other argument, file, variable or connection. */
function maxCalls(argv: string[]): number | null {
  const index = argv.indexOf("--max-calls");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n >= 1 && n <= MAX_RECORD_CALLS ? n : null;
}

function bigintText(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function summary(call: CallRecord, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: call.kind,
    call_name: call.call_name,
    call_ordinal: call.call_ordinal,
    operation_id: call.operation_id,
    status: call.status,
    failure: call.failure,
    http_status: call.http_status,
    reserved_microusd: call.reserved_microusd,
    settled_microusd: call.settlement?.settled_microusd ?? null,
    retained_microusd: call.settlement?.retained_microusd ?? null,
    released_microusd: call.settlement?.released_microusd ?? null,
    operation_state: call.settlement?.state ?? (call.status === "uncertain" ? "uncertain" : null),
    prompt_tokens: call.usage.prompt_tokens,
    completion_tokens: call.usage.completion_tokens,
    input_token_bound: call.input_token_bound,
    prompt_within_bound: call.prompt_within_bound,
    ledger_refusal: call.ledger_refusal,
    ...extra,
  };
}

export async function runRecord(options: RecordOptions): Promise<number> {
  const say = (line: string): void => {
    options.write(`${line}\n`);
  };
  const argv = options.argv[0] === "--" ? options.argv.slice(1) : options.argv;

  const calls = maxCalls(argv);
  if (calls === null) {
    say(`record: --max-calls is required and must be from 1 to ${String(MAX_RECORD_CALLS)}`);
    return 2;
  }

  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        context: { type: "string" },
        "rate-sheet": { type: "string" },
        input: { type: "string" },
        out: { type: "string" },
        "slot-key": { type: "string" },
        pool: { type: "string" },
        "max-calls": { type: "string" },
      },
    }).values;
  } catch {
    say(`record: ${USAGE}`);
    return 2;
  }
  const { context: contextPath, input: inputPath, out, pool } = values;
  const ratePath = values["rate-sheet"];
  const slotKey = values["slot-key"];
  if (!contextPath || !ratePath || !inputPath || !out || !slotKey || !pool) {
    say(`record: ${USAGE}`);
    return 2;
  }

  const apiKey = options.env[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey === "") {
    say(`record: ${API_KEY_VARIABLE} is not set`);
    return 1;
  }
  const databaseUrl = options.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    say("record: DATABASE_URL is not set");
    return 1;
  }

  let context: RunContext;
  let inputs: z.infer<typeof InputsSchema>;
  try {
    context = parseRunContext(JSON.parse(await readFile(contextPath, "utf8")));
    const parsedInputs = InputsSchema.safeParse(JSON.parse(await readFile(inputPath, "utf8")));
    if (!parsedInputs.success) {
      say(`record: the input file does not match the inputs format: ${z.prettifyError(parsedInputs.error)}`);
      return 1;
    }
    inputs = parsedInputs.data;
  } catch (error) {
    say(`record: could not read the context or input file: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }

  let rateSheet: Uint8Array;
  try {
    rateSheet = await readFile(ratePath);
  } catch {
    say("record: unknown_price: the rate file cannot be read");
    return 1;
  }
  const sheet = parseRateSheet(rateSheet);
  const priced = sheet.ok ? buildEnvelope(sheet.entries) : sheet;
  if (!priced.ok) {
    say(`record: unknown_price: ${priced.detail}`);
    return 1;
  }

  let connection: { spend: Spend; close: () => Promise<void> };
  try {
    connection = await options.connect(databaseUrl);
  } catch (error) {
    say(`record: could not connect to the database named by DATABASE_URL (error code ${errorCode(error)})`);
    return 1;
  }
  const { spend } = connection;
  let held = false;
  /** Releases the slot when nothing blocks it; otherwise says which operations keep it held. */
  const release = async (): Promise<boolean> => {
    const released = await spend.releaseSlot({
      slot_key: slotKey,
      root_execution_id: context.root_execution_id,
      actor_role: ACTOR_ROLE,
      evidence: null,
      reason: null,
    });
    if (!released.ok) {
      const blockers = released.blocking_operation_ids?.join(", ") ?? "";
      say(`record: the slot stays held: ${released.code}${blockers === "" ? "" : ` (operations ${blockers})`}`);
      return false;
    }
    return true;
  };
  try {
    const hold = await spend.acquireSlot({
      slot_key: slotKey,
      root_execution_id: context.root_execution_id,
      actor_role: ACTOR_ROLE,
    });
    if (!hold.ok) {
      say(`record: could not acquire the slot: ${hold.code}`);
      return 1;
    }
    held = true;

    const writer = createWriter({
      spend,
      provider: createWriterProvider({ fetch: options.fetch, apiKey }),
      context,
      poolKey: pool,
      allocationKey: null,
      slotKey,
      rateSheet,
    });
    await mkdir(out, { recursive: true });

    const steps: (() => Promise<CardOutcome | IssueOutcome>)[] = [
      () => writer.writeCard({ candidate: inputs.candidate, source: inputs.card }),
      () =>
        writer.writeIssue({
          candidate: inputs.candidate,
          symptom: inputs.issue.symptom,
          excludedIdentifiers: inputs.issue.excluded_identifiers,
        }),
    ];
    let clean = true;
    for (const step of steps.slice(0, calls)) {
      const outcome = await step();
      if (!outcome.ok) {
        const operation = outcome.operation_id === null ? "" : ` (operation ${outcome.operation_id})`;
        say(`record: refused: ${outcome.code}${operation}`);
        clean = false;
        break;
      }
      const { call } = outcome;
      const name = `${call.kind === "writer.card" ? "card" : "issue"}-${String(call.call_ordinal)}`;
      if (call.http_status !== null && call.response_body !== null) {
        const recording = makeRecording({
          requestBody: call.request_body,
          status: call.http_status,
          responseBody: call.response_body,
          provenance: options.provenance,
          recordedAt: options.now().toISOString(),
        });
        await writeFile(join(out, `${name}.recording.json`), serializeRecording(recording));
      }
      const extra =
        "report" in outcome ? { check_report: outcome.report } : { code_owned_fields: outcome.code_owned_fields };
      const text = JSON.stringify(summary(call, extra), bigintText, 2);
      await writeFile(join(out, `${name}.summary.json`), `${text}\n`);
      say(text);

      if (call.status === "uncertain") {
        say(`record: uncertain: lost_response for operation ${call.operation_id}; it needs a manual reconciliation`);
        clean = false;
        break;
      }
      if (call.ledger_refusal !== null) {
        say(`record: the ledger refused a write after launch (${call.ledger_refusal}) for operation ${call.operation_id}`);
        clean = false;
        break;
      }
      if (call.prompt_within_bound === false) {
        say(
          `record: BOUND EXCEEDED: reported prompt tokens ${String(call.usage.prompt_tokens)} exceed the counted bound ${String(call.input_token_bound)} for operation ${call.operation_id}`,
        );
        clean = false;
        break;
      }
      if (call.status !== "completed") {
        clean = false;
      }
    }

    return (await release()) && clean ? 0 : 1;
  } catch (error) {
    const cause = error instanceof WriterInterruptedError ? error.cause : error;
    say(`record: stopped on an unexpected error (${cause instanceof Error ? cause.name : "unknown"}, code ${errorCode(cause)})`);
    if (error instanceof WriterInterruptedError) {
      say(`record: operation ${error.operation_id} may be unresolved; check it with operationStatus`);
    }
    // Spend refuses the release while any operation is unresolved, so trying is always safe.
    if (held) {
      await release().catch((releaseError: unknown) => {
        say(`record: the slot stays held: the release failed (code ${errorCode(releaseError)})`);
      });
    }
    return 1;
  } finally {
    await connection.close();
  }
}
