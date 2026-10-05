import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, MAX_OUTPUT_TOKENS, MODEL_ID } from "../../src/config.ts";
import { createWriterProvider } from "../../src/writer.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, cardSource, symptom } from "../fixtures/cases.ts";
import { openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

function sentBody(body: string | undefined): Record<string, unknown> {
  if (body === undefined) {
    throw new Error("no request was sent");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("the outgoing request", () => {
  it("carries the fixed model, URL, output limit, thinking off and no tools on an issue call", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(outcome.ok).toBe(true);
    expect(r.fetchSpy.calls).toHaveLength(1);
    const call = r.fetchSpy.calls[0];
    expect(call?.url).toBe(`${BASE_URL}chat/completions`);
    expect(BASE_URL).toBe("https://api.tokenfactory.nebius.com/v1/");
    const body = sentBody(call?.body);
    expect(body.model).toBe("nvidia/Nemotron-3_5-Lightning");
    expect(MODEL_ID).toBe("nvidia/Nemotron-3_5-Lightning");
    expect(body.max_tokens).toBe(8192);
    expect(MAX_OUTPUT_TOKENS).toBe(8192);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.response_format).toMatchObject({ type: "json_schema" });
  });

  it("carries the same settings on a card call", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    expect(outcome.ok).toBe(true);
    const body = sentBody(r.fetchSpy.calls[0]?.body);
    expect(body.model).toBe(MODEL_ID);
    expect(body.max_tokens).toBe(8192);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty("tools");
  });

  it("sends the exact bytes it hashed into payload_hash", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    const { createHash } = await import("node:crypto");
    const sent = r.fetchSpy.calls[0]?.body ?? "";
    expect(outcome.call.request_body).toBe(sent);
    expect(outcome.call.payload_hash).toBe(createHash("sha256").update(sent).digest("hex"));
  });

  it("calls the provider exactly once on an HTTP 500, with no retry", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("http-500"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(r.fetchSpy.calls).toHaveLength(1);
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("failed");
    expect(outcome.call.failure).toBe("http_status");
    expect(outcome.call.http_status).toBe(500);
  });

  it("sends the key only as a bearer header, and keeps it out of the call record", async () => {
    const keyed = await rig(db, { apiKey: "synthetic-key-value" });
    const outcome = await keyed.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(keyed.fetchSpy.calls[0]?.headers.authorization).toBe("Bearer synthetic-key-value");
    expect(JSON.stringify(outcome, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
      "synthetic-key-value",
    );

    const keyless = await rig(db);
    await keyless.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(keyless.fetchSpy.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses to construct a provider without an injected fetch", () => {
    expect(() => createWriterProvider({ fetch: undefined as never })).toThrow(/fetch/);
  });
});
