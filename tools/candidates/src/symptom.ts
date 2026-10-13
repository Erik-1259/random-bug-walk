// Per-class symptom templates. The screen is told a symptom that describes the planted bug's
// user-visible effect without naming the site or the fix. No model writes it: the text is derived
// from the site alone — the endpoint implied by the file location and the name of the model the
// diff touches. It describes only what a user would see; it names no method call, no field and no
// read-then-write mechanics from the code, so it does not point a reader at the changed statement.
import type { Site } from "./types.ts";

/** A name for the template generation, recorded so a reader knows how the symptoms were made. */
export const SYMPTOM_SOURCE = "race-class-template-v2";

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

/**
 * The name of the kind of thing the diff writes, as a user would name it (the model name only, never
 * the method). Prefers the model of an upsert, then of any write, then of any call.
 */
function thingName(diff: string): string | null {
  const calls = modelCalls(diff);
  const call = calls.find((c) => c.method === "upsert") ?? calls.find((c) => WRITE_METHODS.has(c.method)) ?? calls[0];
  return call === undefined ? null : call.model;
}

function placeOf(site: Site): string {
  const where = endpointOf(site.file);
  return where === null ? `in ${locationPhrase(site.file)}` : `to \`${where}\``;
}

/**
 * The symptom for a `RACE.check-then-act` site (in the code, an upsert split into a lookup and a
 * separate insert). It says only what a user sees: two simultaneous requests leave two entries.
 */
function checkThenActSymptom(site: Site): string {
  const thing = thingName(site.diff);
  const entry = thing === null ? "entry" : `${thing} entry`;
  return [
    `When two requests arrive ${placeOf(site)} at the same moment, both appear to succeed even though only one should.`,
    `Afterwards the user has a duplicate ${entry} instead of a single one, or a later request fails on a conflict that should never have been possible.`,
    `Sent one at a time, the same requests behave correctly.`,
  ].join(" ");
}

/**
 * The symptom for a `RACE.guarded-write` site (in the code, a one-time state change whose guard was
 * removed). It says only what a user sees: a one-time action, sent twice at once, takes effect twice.
 */
function guardedWriteSymptom(site: Site): string {
  const thing = thingName(site.diff);
  const subject = thing === null ? "the same one-time action" : `the same ${thing}`;
  return [
    `When the same request is sent ${placeOf(site)} twice at the same moment, both succeed even though only one should.`,
    `An action that should take effect once takes effect twice — for example, ${subject} is accepted for both requests.`,
    `Sent one after the other, the second request is correctly refused.`,
  ].join(" ");
}

/** A generic race symptom when the class is unknown (a fake finder, or an unrecognized class). */
function genericRaceSymptom(site: Site): string {
  return [
    `When two requests arrive ${placeOf(site)} at the same moment, both can succeed even though only one should.`,
    `A user sees an operation that should happen at most once happen twice under concurrent load.`,
  ].join(" ");
}

/**
 * The symptom text for a site, by its class. It names the endpoint (from the file location) and, at
 * most, the name of the model the diff touches; never a method call, a field or the changed line.
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
