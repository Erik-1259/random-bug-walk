// Per-class symptom templates. The screen is told a symptom that describes the planted bug's
// user-visible effect without naming the site or the fix. No model writes it: the text is derived
// from the site alone — the endpoint implied by the file location and the model and action the diff
// touches. It never names the guard key that the fix removes, nor the line the change is on.
import type { Site } from "./types.ts";

/** A name for the template generation, recorded so a reader knows how the symptoms were made. */
export const SYMPTOM_SOURCE = "race-class-template-v1";

const WRITE_METHODS = new Set(["update", "updateMany", "delete", "deleteMany", "create", "createMany", "upsert"]);
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count"]);

interface ModelCall {
  model: string;
  method: string;
}

/**
 * The `<model>.<method>` pairs a diff touches, in order of appearance, keeping only Prisma-style
 * read and write methods. Reads the diff text as plain source: a leading `+`, `-` or space from the
 * unified-diff format does not start an identifier, so it does not affect the match.
 */
export function modelCalls(diff: string): ModelCall[] {
  const calls: ModelCall[] = [];
  const pattern = /([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of diff.matchAll(pattern)) {
    const model = match[1];
    const method = match[2];
    if (model !== undefined && method !== undefined && (WRITE_METHODS.has(method) || READ_METHODS.has(method))) {
      calls.push({ model, method });
    }
  }
  return calls;
}

/**
 * The endpoint a file implies, for a Next-style tree. A file under an `api` directory becomes a
 * path from `api` onward; a `route` filename is dropped (the directory is the route), any other
 * filename is kept, route groups like `(group)` are dropped and a dynamic `[id]` segment becomes
 * `:id`. A file with no `api` directory has no endpoint.
 */
export function endpointOf(file: string): string | null {
  const parts = file.replace(/\.(ts|tsx)$/, "").split("/");
  const apiAt = parts.indexOf("api");
  if (apiAt === -1) {
    return null;
  }
  const rest = parts.slice(apiAt);
  if (rest[rest.length - 1] === "route") {
    rest.pop();
  }
  const segments = rest
    .filter((part) => !/^\(.*\)$/.test(part))
    .map((part) => part.replace(/^\[(\.\.\.)?(.+)\]$/, ":$2"));
  return `/${segments.join("/")}`;
}

/** A short phrase naming where the operation lives, for a symptom that has no endpoint. */
function locationPhrase(file: string): string {
  const base = file.replace(/\.(ts|tsx)$/, "").split("/").pop() ?? "operation";
  return `the ${base} operation`;
}

function writeCall(diff: string): ModelCall | undefined {
  const calls = modelCalls(diff);
  return calls.find((call) => call.method === "upsert") ?? calls.find((call) => WRITE_METHODS.has(call.method)) ?? calls[0];
}

/**
 * The symptom for a `RACE.check-then-act` site: an upsert split into a read then a write, so two
 * concurrent requests can both see no record and both create one.
 */
function checkThenActSymptom(site: Site): string {
  const where = endpointOf(site.file);
  const place = where === null ? `in ${locationPhrase(site.file)}` : `to \`${where}\``;
  const call = writeCall(site.diff);
  const record = call === undefined ? "record" : `\`${call.model}\` record`;
  return [
    `When two requests arrive ${place} at the same moment, both can appear to succeed even though only one should.`,
    `Each request first checks whether the ${record} already exists and, finding none, goes on to create it;`,
    `because both run before either has saved its result, both create the record.`,
    `The result a user sees is a duplicate ${record} when there should be only one, or a later request failing on a uniqueness conflict that should never have been possible.`,
  ].join(" ");
}

/**
 * The symptom for a `RACE.guarded-write` site: a read of a record followed by a conditional write of
 * the same record, so two concurrent requests can both read the old state and both write.
 */
function guardedWriteSymptom(site: Site): string {
  const where = endpointOf(site.file);
  const place = where === null ? `in ${locationPhrase(site.file)}` : `to \`${where}\``;
  const calls = modelCalls(site.diff);
  const write = calls.find((call) => WRITE_METHODS.has(call.method));
  const action = write === undefined ? "updates a record" : `calls \`${write.model}.${write.method}\``;
  const record = write === undefined ? "the record" : `the same \`${write.model}\` record`;
  return [
    `When two requests arrive ${place} at the same moment, both can succeed even though only one should.`,
    `Each request reads ${record}, decides it is in the state it needs, and then ${action};`,
    `because both reads happen before either write is saved, the second request acts on state that is already stale, and an operation that should apply to only one request applies to both.`,
    `A user can, in effect, make the same one-time change twice — for example spending or consuming something that should be usable only once.`,
  ].join(" ");
}

/** A generic race symptom when the class is unknown (a fake finder, or an unrecognized class). */
function genericRaceSymptom(site: Site): string {
  const where = endpointOf(site.file);
  const place = where === null ? `in ${locationPhrase(site.file)}` : `to \`${where}\``;
  return [
    `When two requests arrive ${place} at the same moment, both can succeed even though only one should.`,
    `Each reads the current state and then writes, but the reads happen before either write is saved, so both act on stale state.`,
    `A user sees an operation that should happen at most once happen twice under concurrent load.`,
  ].join(" ");
}

/**
 * The symptom text for a site, by its class. It names the endpoint (from the file location) and the
 * model and action (from the diff), never the guard the fix removes or the line it is on.
 */
export function symptomFor(site: Site): string {
  switch (site.classId) {
    case "RACE.check-then-act":
      return checkThenActSymptom(site);
    case "RACE.guarded-write":
      return guardedWriteSymptom(site);
    default:
      return genericRaceSymptom(site);
  }
}
