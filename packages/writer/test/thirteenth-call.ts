// Child process for the call-cap test: opens an on-disk PGlite ledger that already holds twelve
// calls for the synthetic candidate, attempts a thirteenth with a new writer, and prints the outcome.
// Usage: node test/thirteenth-call.ts <data-dir> <schema>
import { createSpend } from "@rbw/spend";
import { CANDIDATE, CONTEXT, EXCLUDED_IDENTIFIERS, symptom } from "./fixtures/cases.ts";
import { createWriter, createWriterProvider } from "../src/writer.ts";
import { POOL, SLOT, committedRecordings, openDb, rateSheetBytes, spyFetch, spySpend } from "./support.ts";
import { createReplayFetch } from "../src/recording.ts";

const [dataDir, schema] = process.argv.slice(2);
if (dataDir === undefined || schema === undefined) {
  throw new Error("usage: thirteenth-call.ts <data-dir> <schema>");
}
const db = await openDb(dataDir);
const events: string[] = [];
const fetchSpy = spyFetch(createReplayFetch(await committedRecordings()), events);
const writer = createWriter({
  spend: spySpend(createSpend({ client: db, schema }), events),
  provider: createWriterProvider({ fetch: fetchSpy.fetch }),
  context: CONTEXT,
  poolKey: POOL,
  allocationKey: null,
  slotKey: SLOT,
  rateSheet: rateSheetBytes(),
});
const outcome = await writer.writeIssue({
  candidate: CANDIDATE,
  symptom: symptom("valid"),
  excludedIdentifiers: EXCLUDED_IDENTIFIERS,
});
await db.close();
process.stdout.write(
  `${JSON.stringify({
    code: outcome.ok ? "called" : outcome.code,
    fetch_calls: fetchSpy.calls.length,
    reserve_calls: events.filter((e) => e === "reserve").length,
  })}\n`,
);
