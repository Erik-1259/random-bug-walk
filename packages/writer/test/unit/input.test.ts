import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseObservedSymptom } from "../../src/observed-symptom.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, symptom } from "../fixtures/cases.ts";
import { openDb, operationCount, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

const bad: [string, Record<string, unknown>][] = [
  ["an extra top-level field", { ...symptom("valid"), stack_trace: "synthetic frame" }],
  ["a missing field", without(symptom("valid"), "doc_excerpts")],
  ["a wrong schema_version", { ...symptom("valid"), schema_version: 2 }],
  [
    "an extra nested field",
    { ...symptom("valid"), request: { method: "GET", path: "/api/synthetic", query: {}, handler: "synthetic" } },
  ],
  ["a null locale missing", without(symptom("valid"), "locale")],
  ["an unknown timezone", { ...symptom("valid"), timezone: "Synthetic/Nowhere" }],
];

describe("issue input is a strict ObservedSymptom", () => {
  it.each(bad)("refuses %s before reserving or calling", async (_name, value) => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: value,
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(r.fetchSpy.calls).toHaveLength(0);
    expect(r.events).toEqual([]);
    expect(await operationCount(db, r.schema)).toBe(0);
  });

  it("accepts the synthetic observation and a null locale", () => {
    expect(parseObservedSymptom(symptom("valid")).ok).toBe(true);
    expect(parseObservedSymptom({ ...symptom("valid"), locale: null }).ok).toBe(true);
  });

  it("refuses a candidate name that cannot form a spend call name", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: "Synthetic Candidate!",
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(r.fetchSpy.calls).toHaveLength(0);
  });
});
