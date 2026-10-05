import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_INPUT_TOKENS, PER_MESSAGE_FRAMING_TOKENS, PER_REQUEST_FRAMING_TOKENS } from "../../src/config.ts";
import { countPromptBound } from "../../src/prompt-bound.ts";
import { makeRecording } from "../../src/recording.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, ISSUE_OUTPUTS, SYNTHETIC_USAGE, completion, symptom } from "../fixtures/cases.ts";
import { openDb, operationCount, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

describe("countPromptBound", () => {
  it("adds UTF-8 bytes of every message, the serialized schema and the framing allowances", () => {
    const responseFormat = { type: "json_schema", json_schema: { schema: { type: "object" }, name: "response" } };
    const body = JSON.stringify({
      model: "synthetic",
      messages: [
        { role: "system", content: "ab" },
        { role: "user", content: "ü€" },
      ],
      response_format: responseFormat,
    });
    const schemaBytes = Buffer.byteLength(JSON.stringify(responseFormat), "utf8");
    expect(countPromptBound(body)).toBe(2 + 5 + 2 * PER_MESSAGE_FRAMING_TOKENS + schemaBytes + PER_REQUEST_FRAMING_TOKENS);
  });

  it("counts text parts of array content and refuses a body it cannot count", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "abc" }] }] });
    expect(countPromptBound(body)).toBe(3 + PER_MESSAGE_FRAMING_TOKENS + PER_REQUEST_FRAMING_TOKENS);
    expect(() => countPromptBound(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image" }] }] }))).toThrow();
    expect(() => countPromptBound("not json")).toThrow();
  });
});

describe("the prompt bound is enforced before launch", () => {
  async function paddedToBound(target: number): Promise<Record<string, unknown>> {
    const r = await rig(db, { acquireSlot: false });
    const base = symptom("bound");
    const preview = await r.writer.previewIssue(base);
    if (!preview.ok) {
      throw new Error(preview.code);
    }
    const padding = target - preview.input_token_bound;
    expect(padding).toBeGreaterThan(0);
    const padded = { ...base, user_action: `${String(base.user_action)}${"a".repeat(padding)}` };
    const check = await r.writer.previewIssue(padded);
    if (!check.ok) {
      throw new Error(check.code);
    }
    expect(check.input_token_bound).toBe(target);
    return padded;
  }

  it("allows a request whose bound is exactly the limit", async () => {
    const padded = await paddedToBound(MAX_INPUT_TOKENS);
    const probe = await rig(db, { acquireSlot: false });
    const preview = await probe.writer.previewIssue(padded);
    if (!preview.ok) {
      throw new Error(preview.code);
    }
    const recording = makeRecording({
      requestBody: preview.request_body,
      status: 200,
      responseBody: completion(JSON.stringify(ISSUE_OUTPUTS.valid), SYNTHETIC_USAGE),
      provenance: "synthetic",
      recordedAt: "2026-10-05T00:00:00Z",
    });
    const r = await rig(db, { extraRecordings: [recording] });
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: padded,
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.input_token_bound).toBe(MAX_INPUT_TOKENS);
    expect(outcome.call.status).toBe("completed");
    expect(r.fetchSpy.calls).toHaveLength(1);
  });

  it("refuses one byte over the limit with prompt_too_large, reserving and calling nothing", async () => {
    const padded = await paddedToBound(MAX_INPUT_TOKENS + 1);
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: padded,
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(outcome).toMatchObject({ ok: false, code: "prompt_too_large" });
    expect(r.events).toEqual([]);
    expect(r.fetchSpy.calls).toHaveLength(0);
    expect(await operationCount(db, r.schema)).toBe(0);
  });

  it("refuses an oversized card request the same way", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeCard({
      candidate: CANDIDATE,
      source: {
        source_links: ["https://code.example.invalid/synthetic"],
        repository: "https://code.example.invalid/synthetic",
        date: "2026-01-15",
        license: "MIT",
        diff_excerpt: "x".repeat(MAX_INPUT_TOKENS),
        issue_text: "synthetic",
        confirmation: { card_id: "synthetic-card", shape_id: "synthetic-shape", rules_matched: [], matched_lines: [] },
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "prompt_too_large" });
    expect(r.events).toEqual([]);
    expect(await operationCount(db, r.schema)).toBe(0);
  });
});
