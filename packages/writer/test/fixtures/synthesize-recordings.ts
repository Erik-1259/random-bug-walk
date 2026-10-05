// Regenerates the committed synthetic recordings: renders each case's request with the writer's own
// request builder (nothing is sent), pairs it with the case's synthetic response, and writes one
// file per case labelled `synthetic`. Run after changing a prompt or a schema:
//   node test/fixtures/synthesize-recordings.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Spend } from "@rbw/spend";
import { makeRecording, serializeRecording } from "../../src/recording.ts";
import { createWriter, createWriterProvider } from "../../src/writer.ts";
import type { Preview } from "../../src/writer.ts";
import { RECORDINGS_DIR, rateSheetBytes } from "../support.ts";
import {
  CARD_CASES,
  CARD_OUTPUTS,
  CONTEXT,
  ISSUE_CASES,
  ISSUE_OUTPUTS,
  SYNTHETIC_USAGE,
  cardSource,
  completion,
  symptom,
} from "./cases.ts";

const RECORDED_AT = "2026-10-05T00:00:00Z";

// Rendering a request never touches the ledger.
const noLedger = new Proxy(
  {},
  {
    get() {
      throw new Error("rendering a request must not use the spend ledger");
    },
  },
) as Spend;

const writer = createWriter({
  spend: noLedger,
  provider: createWriterProvider({ fetch: () => Promise.reject(new Error("rendering sends nothing")) }),
  context: CONTEXT,
  poolKey: "synthetic-pool",
  allocationKey: null,
  slotKey: "synthetic-slot",
  rateSheet: rateSheetBytes(),
});

function body(preview: Preview): string {
  if (!preview.ok) {
    throw new Error(`could not render a request: ${preview.code}`);
  }
  return preview.request_body;
}

function response(output: unknown, usage: typeof SYNTHETIC_USAGE | null): { status: number; responseBody: string } {
  if (output === null) {
    return { status: 500, responseBody: JSON.stringify({ error: { message: "synthetic internal error" } }) };
  }
  return { status: 200, responseBody: completion(JSON.stringify(output), usage) };
}

async function write(file: string, requestBody: string, reply: { status: number; responseBody: string }): Promise<void> {
  const recording = makeRecording({ requestBody, ...reply, provenance: "synthetic", recordedAt: RECORDED_AT });
  await writeFile(join(RECORDINGS_DIR, file), serializeRecording(recording));
}

// One provider renders one request at a time, so the cases run in sequence.
await mkdir(RECORDINGS_DIR, { recursive: true });
for (const name of ISSUE_CASES) {
  const usage = name === "missing-usage" ? null : SYNTHETIC_USAGE;
  await write(`issue-${name}.json`, body(await writer.previewIssue(symptom(name))), response(ISSUE_OUTPUTS[name], usage));
}
for (const name of CARD_CASES) {
  await write(`card-${name}.json`, body(await writer.previewCard(cardSource(name))), response(CARD_OUTPUTS[name], SYNTHETIC_USAGE));
}
process.stdout.write(`wrote ${String(ISSUE_CASES.length + CARD_CASES.length)} synthetic recordings\n`);
