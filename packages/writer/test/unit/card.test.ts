import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CardSourceSchema, buildCardPrompt } from "../../src/card-prompt.ts";
import { BUG_CLASSES, CardSchema, RUNTIME_LEVERS } from "../../src/card-schema.ts";
import { makeRecording } from "../../src/recording.ts";
import {
  CANDIDATE,
  CARD_OUTPUTS,
  EXCLUDED_IDENTIFIERS,
  SYNTHETIC_USAGE,
  cardSource,
  completion,
  symptom,
} from "../fixtures/cases.ts";
import { openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const VALID = CARD_OUTPUTS.valid as Record<string, unknown>;
const VALID_DEPENDENCE = VALID.runtime_dependence as { value: string; reason: string; levers: Record<string, string> };

/** The published form of the valid model answer: the three lever lists, in RUNTIME_LEVERS order. */
const PUBLISHED = {
  ...VALID,
  runtime_dependence: {
    value: VALID_DEPENDENCE.value,
    reason: VALID_DEPENDENCE.reason,
    levers_apply: ["hidden_runtime_state", "magnitude_visible_only_at_runtime"],
    levers_absent: ["ordering_or_concurrency", "external_side_effect_semantics"],
    levers_unverified: ["distance_between_symptom_and_cause", "plausible_wrong_static_fix", "path_ambiguity"],
  },
};

/** The runtime_dependence of the first live card answer, verbatim. */
const LIVE_DEPENDENCE = {
  value: "unknown",
  reason:
    "levers_apply: [timezone]; levers_absent: [exact_time, epoch_ref, quantize, timezone_offset, locale]; levers_unverified: [cron, calendar]",
  levers_apply: ["external_side_effect_semantics"],
  levers_absent: ["external_side_effect_semantics", "external_side_effect_semantics"],
  levers_unverified: ["external_side_effect_semantics"],
};

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
    expect(CardSchema.safeParse(PUBLISHED).success).toBe(true);
    expect(CardSchema.safeParse({ ...PUBLISHED, bug_class: "memory_leaks" }).success).toBe(false);
  });

  it("refuses an extra field, a bad tier and a lever listed twice or not at all", () => {
    expect(CardSchema.safeParse({ ...PUBLISHED, notes: "synthetic" }).success).toBe(false);
    expect(CardSchema.safeParse({ ...PUBLISHED, fidelity_tier: "D" }).success).toBe(false);
    const dependence = PUBLISHED.runtime_dependence;
    expect(
      CardSchema.safeParse({
        ...PUBLISHED,
        runtime_dependence: { ...dependence, levers_absent: ["ordering_or_concurrency", "hidden_runtime_state"] },
      }).success,
    ).toBe(false);
    expect(
      CardSchema.safeParse({ ...PUBLISHED, runtime_dependence: { ...dependence, levers_unverified: [] } }).success,
    ).toBe(false);
  });
});

describe("the schema sent to the model", () => {
  async function sentSchema(): Promise<Record<string, unknown>> {
    const preview = await (await rig(db, { acquireSlot: false })).writer.previewCard(cardSource("valid"));
    if (!preview.ok) {
      throw new Error(preview.code);
    }
    const body = JSON.parse(preview.request_body) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    return body.response_format.json_schema.schema;
  }

  it("asks for runtime_dependence as value, reason and one required state per lever, and nothing else", async () => {
    const schema = await sentSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const dependence = properties.runtime_dependence;
    expect(Object.keys(dependence?.properties as object)).toEqual(["value", "reason", "levers"]);
    expect(dependence?.required).toEqual(["value", "reason", "levers"]);
    expect(dependence?.additionalProperties).toBe(false);
    const levers = (dependence?.properties as Record<string, Record<string, unknown>>).levers;
    expect(levers?.type).toBe("object");
    expect(Object.keys(levers?.properties as object)).toEqual([...RUNTIME_LEVERS]);
    expect(levers?.required).toEqual([...RUNTIME_LEVERS]);
    expect(levers?.additionalProperties).toBe(false);
    for (const lever of RUNTIME_LEVERS) {
      expect((levers?.properties as Record<string, unknown>)[lever], lever).toEqual({
        type: "string",
        enum: ["apply", "absent", "unverified"],
      });
    }
  });

  it("has no lever lists anywhere", async () => {
    const text = JSON.stringify(await sentSchema());
    expect(text).toContain("runtime_dependence");
    for (const list of ["levers_apply", "levers_absent", "levers_unverified"]) {
      expect(text).not.toContain(list);
    }
  });

  it("describes each lever's state in the prompt and no longer asks for the lists", () => {
    const { system } = buildCardPrompt(CardSourceSchema.parse(cardSource("valid")));
    expect(system).toContain("runtime_dependence.levers gives each of the seven levers one state: apply, absent or unverified");
    for (const lever of RUNTIME_LEVERS) {
      expect(system).toMatch(new RegExp(`^  - ${lever}: \\S`, "m"));
    }
    expect(system).not.toMatch(/levers_apply|levers_absent|levers_unverified|each lever appears/);
  });

  it("keeps the published card schema's three lever lists", () => {
    expect(Object.keys(CardSchema.shape.runtime_dependence.shape)).toEqual([
      "value",
      "reason",
      "levers_apply",
      "levers_absent",
      "levers_unverified",
    ]);
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

  describe("with a model answer recorded for a dedicated source", () => {
    async function writeWith(variant: string, output: Record<string, unknown>) {
      const preview = await (await rig(db, { acquireSlot: false })).writer.previewCard(cardSource(variant));
      if (!preview.ok) {
        throw new Error(preview.code);
      }
      const recording = makeRecording({
        requestBody: preview.request_body,
        status: 200,
        responseBody: completion(JSON.stringify(output), SYNTHETIC_USAGE),
        provenance: "synthetic",
        recordedAt: "2026-10-05T00:00:00Z",
      });
      const r = await rig(db, { extraRecordings: [recording] });
      const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource(variant) });
      if (!outcome.ok) {
        throw new Error(outcome.code);
      }
      return outcome;
    }

    it.each([
      ["an empty id", "empty-id", { id: "" }],
      ["an invalid provenance URL", "bad-provenance-url", { provenance: { ...(VALID.provenance as object), source_links: ["not a url"] } }],
      ["a shape with an empty shape_id", "empty-shape-id", { shape: { ...(VALID.shape as object), shape_id: "" } }],
    ])("keeps a card whose model answer has %s in a code-owned field", async (_label, variant, change) => {
      const outcome = await writeWith(variant, { ...VALID, ...change });
      expect(outcome.call.status).toBe("completed");
      expect(outcome.call.failure).toBeNull();
      expect(outcome.card).not.toBeNull();
      expect(CardSchema.safeParse(outcome.card).success).toBe(true);
      expect(outcome.card?.id).toBe("synthetic-card-1");
      expect(outcome.card?.provenance.source_links).toEqual(["https://code.example.invalid/synthetic-project/pull/1"]);
      expect(outcome.card?.shape.shape_id).toBe("synthetic-shape-1");
      expect(outcome.card?.mechanism).toBe(VALID.mechanism);
    });

    it("derives the three published lever lists from levers, in RUNTIME_LEVERS order", async () => {
      // The model's key order is reversed, so a list kept in answer order would come out reversed.
      const reversed = Object.fromEntries(Object.entries(VALID_DEPENDENCE.levers).reverse());
      const outcome = await writeWith("levers-reversed", {
        ...VALID,
        runtime_dependence: { ...VALID_DEPENDENCE, levers: reversed },
      });
      expect(outcome.call.status).toBe("completed");
      expect(outcome.card?.runtime_dependence).toEqual(PUBLISHED.runtime_dependence);
      expect(outcome.card?.runtime_dependence).not.toHaveProperty("levers");
      expect(CardSchema.safeParse(outcome.card).success).toBe(true);
    });

    it("puts every lever in the list its state names", async () => {
      const levers = Object.fromEntries(RUNTIME_LEVERS.map((lever) => [lever, "unverified"]));
      const outcome = await writeWith("levers-all-unverified", {
        ...VALID,
        runtime_dependence: { ...VALID_DEPENDENCE, levers: { ...levers, path_ambiguity: "apply" } },
      });
      expect(outcome.card?.runtime_dependence.levers_apply).toEqual(["path_ambiguity"]);
      expect(outcome.card?.runtime_dependence.levers_absent).toEqual([]);
      expect(outcome.card?.runtime_dependence.levers_unverified).toEqual(
        RUNTIME_LEVERS.filter((lever) => lever !== "path_ambiguity"),
      );
    });

    it("refuses the live answer's three lists as invalid_output", async () => {
      const outcome = await writeWith("live-lists", { ...VALID, runtime_dependence: LIVE_DEPENDENCE });
      expect(outcome.call.status).toBe("failed");
      expect(outcome.call.failure).toBe("invalid_output");
      expect(outcome.card).toBeNull();
    });

    it("refuses the live answer reshaped into levers with one lever missing", async () => {
      const levers: Record<string, string> = {
        hidden_runtime_state: "absent",
        distance_between_symptom_and_cause: "absent",
        plausible_wrong_static_fix: "unverified",
        path_ambiguity: "absent",
        ordering_or_concurrency: "absent",
        magnitude_visible_only_at_runtime: "unverified",
      };
      const outcome = await writeWith("live-levers-missing", {
        ...VALID,
        runtime_dependence: { value: LIVE_DEPENDENCE.value, reason: LIVE_DEPENDENCE.reason, levers },
      });
      expect(outcome.call.status).toBe("failed");
      expect(outcome.call.failure).toBe("invalid_output");
      expect(outcome.card).toBeNull();
    });

    it("keeps the live answer reshaped into complete levers", async () => {
      const levers = {
        hidden_runtime_state: "absent",
        distance_between_symptom_and_cause: "absent",
        plausible_wrong_static_fix: "unverified",
        path_ambiguity: "absent",
        ordering_or_concurrency: "absent",
        magnitude_visible_only_at_runtime: "unverified",
        external_side_effect_semantics: "apply",
      };
      const outcome = await writeWith("live-levers-complete", {
        ...VALID,
        runtime_dependence: { value: LIVE_DEPENDENCE.value, reason: LIVE_DEPENDENCE.reason, levers },
      });
      expect(outcome.call.status).toBe("completed");
      expect(outcome.card?.runtime_dependence).toEqual({
        value: "unknown",
        reason: LIVE_DEPENDENCE.reason,
        levers_apply: ["external_side_effect_semantics"],
        levers_absent: ["hidden_runtime_state", "distance_between_symptom_and_cause", "path_ambiguity", "ordering_or_concurrency"],
        levers_unverified: ["plausible_wrong_static_fix", "magnitude_visible_only_at_runtime"],
      });
      expect(CardSchema.safeParse(outcome.card).success).toBe(true);
    });

    it.each([
      ["an extra lever key", "levers-extra-key", { ...VALID_DEPENDENCE.levers, locale: "absent" }],
      ["a state outside the three", "levers-bad-state", { ...VALID_DEPENDENCE.levers, path_ambiguity: "maybe" }],
    ])("refuses levers with %s as invalid_output", async (_label, variant, levers) => {
      const outcome = await writeWith(variant, { ...VALID, runtime_dependence: { ...VALID_DEPENDENCE, levers } });
      expect(outcome.call.failure).toBe("invalid_output");
      expect(outcome.card).toBeNull();
    });

    it("keeps value as the model gave it, since the schema ties value to no lever", async () => {
      const absent = Object.fromEntries(RUNTIME_LEVERS.map((lever) => [lever, "absent"]));
      const outcome = await writeWith("value-unknown-all-absent", {
        ...VALID,
        runtime_dependence: { ...VALID_DEPENDENCE, value: "unknown", levers: absent },
      });
      expect(outcome.call.status).toBe("completed");
      expect(outcome.card?.runtime_dependence.value).toBe("unknown");
      expect(outcome.card?.runtime_dependence.levers_absent).toEqual([...RUNTIME_LEVERS]);
    });

    it("still fails the call on a malformed model-owned field", async () => {
      const outcome = await writeWith("empty-mechanism", { ...VALID, mechanism: "" });
      expect(outcome.call.status).toBe("failed");
      expect(outcome.call.failure).toBe("invalid_output");
      expect(outcome.card).toBeNull();
    });
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
