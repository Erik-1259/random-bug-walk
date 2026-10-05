import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUG_CLASSES, CardSchema, RUNTIME_LEVERS } from "../../src/card-schema.ts";
import { CANDIDATE, CARD_OUTPUTS, EXCLUDED_IDENTIFIERS, cardSource, symptom } from "../fixtures/cases.ts";
import { openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const VALID = CARD_OUTPUTS.valid as Record<string, unknown>;

/** Every string leaf of a value, for the isolation check. */
function leaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(leaves);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(leaves);
  }
  return [];
}

describe("the card schema", () => {
  it("has exactly the eight bug classes", () => {
    expect([...BUG_CLASSES]).toEqual([
      "time_and_date",
      "data_validation",
      "permissions",
      "async_ordering_and_races",
      "caching_and_stale_state",
      "configuration_and_environment",
      "ui_state_and_hydration",
      "api_contract",
    ]);
  });

  it("has exactly the seven runtime levers", () => {
    expect(RUNTIME_LEVERS).toHaveLength(7);
  });

  it("refuses a bug class outside the list", () => {
    expect(CardSchema.safeParse(VALID).success).toBe(true);
    expect(CardSchema.safeParse({ ...VALID, bug_class: "memory_leaks" }).success).toBe(false);
  });

  it("refuses an extra field, a bad tier and a lever listed twice or not at all", () => {
    expect(CardSchema.safeParse({ ...VALID, notes: "synthetic" }).success).toBe(false);
    expect(CardSchema.safeParse({ ...VALID, fidelity_tier: "D" }).success).toBe(false);
    const dependence = VALID.runtime_dependence as Record<string, unknown>;
    expect(
      CardSchema.safeParse({
        ...VALID,
        runtime_dependence: { ...dependence, levers_absent: ["ordering_or_concurrency", "hidden_runtime_state"] },
      }).success,
    ).toBe(false);
    expect(
      CardSchema.safeParse({ ...VALID, runtime_dependence: { ...dependence, levers_unverified: [] } }).success,
    ).toBe(false);
  });
});

describe("the card writer", () => {
  it("overwrites the code-owned fields from the caller's confirmation and records that it did", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("completed");
    expect(outcome.card?.id).toBe("synthetic-card-1");
    expect(outcome.card?.provenance).toEqual({
      source_links: ["https://code.example.invalid/synthetic-project/pull/1"],
      repository: "https://code.example.invalid/synthetic-project",
      date: "2026-01-15",
      license: "MIT",
    });
    expect(outcome.card?.shape).toEqual({
      shape_id: "synthetic-shape-1",
      rules_matched: ["synthetic-rule-a", "synthetic-rule-b"],
      matched_lines: ["+ const range = synthetic(start, end, zone);"],
    });
    expect(outcome.code_owned_fields).toEqual([
      { field: "id", overwritten: true },
      { field: "provenance", overwritten: true },
      { field: "shape", overwritten: true },
    ]);
    expect(outcome.card?.bug_class).toBe("time_and_date");
  });

  it("treats an out-of-list bug class from the model as a failed call", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("bug-class-out-of-list") });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("failed");
    expect(outcome.call.failure).toBe("invalid_output");
    expect(outcome.card).toBeNull();
  });

  it("refuses card input with an unknown field before reserving", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeCard({
      candidate: CANDIDATE,
      source: { ...cardSource("valid"), stack_trace: "synthetic" },
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(r.events).toEqual([]);
  });
});

describe("issue isolation", () => {
  it("puts no card field value into the issue request, with a card in the same process", async () => {
    const r = await rig(db);
    const card = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    if (!card.ok || card.card === null) {
      throw new Error("expected a card");
    }
    const issue = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    if (!issue.ok) {
      throw new Error(issue.code);
    }
    const sent = r.fetchSpy.calls[1]?.body ?? "";
    expect(sent).toBe(issue.call.request_body);
    const values = [...leaves(card.card), ...leaves(cardSource("valid"))].filter((v) => v.length >= 4);
    expect(values.length).toBeGreaterThan(20);
    for (const value of values) {
      expect(sent, value).not.toContain(value);
    }
  });

  it("keeps the issue prompt builder free of card imports", async () => {
    const source = await readFile(new URL("../../src/issue-prompt.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/card/i);
    }
  });
});
