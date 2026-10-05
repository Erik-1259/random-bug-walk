import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, MODEL_ID } from "../../src/config.ts";
import { RequestNotSentError } from "../../src/http.ts";
import { createReplayFetch, loadRecordings, makeRecording, requestKey } from "../../src/recording.ts";
import { CARD_CASES, ISSUE_CASES, cardSource, symptom } from "../fixtures/cases.ts";
import { RECORDINGS_DIR, committedRecordings, openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

const URL_OK = `${BASE_URL}chat/completions`;
const KEY_LIKE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/;

describe("committed recordings", () => {
  it("cover every synthetic case, each labelled synthetic", async () => {
    const files = (await readdir(RECORDINGS_DIR)).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(
      [...CARD_CASES.map((c) => `card-${c}.json`), ...ISSUE_CASES.map((c) => `issue-${c}.json`)].sort(),
    );
    for (const recording of await committedRecordings()) {
      expect(recording.provenance).toBe("synthetic");
      expect(recording.model_id).toBe(MODEL_ID);
    }
  });

  it("hold no header, no Authorization value and nothing key-like", async () => {
    for (const file of await readdir(RECORDINGS_DIR)) {
      const text = await readFile(join(RECORDINGS_DIR, file), "utf8");
      expect(text, file).not.toMatch(/authorization|bearer|api[_-]?key|"headers"/i);
      // The match key is the one long hexadecimal value a recording is meant to hold.
      const withoutKey = text.replace(/"request_sha256": "[0-9a-f]{64}"/, "");
      expect(withoutKey, file).not.toMatch(KEY_LIKE);
    }
  });

  it("match the requests the writer builds today", async () => {
    const r = await rig(db, { acquireSlot: false });
    const keys = new Set((await committedRecordings()).map((rec) => rec.request_sha256));
    for (const variant of ISSUE_CASES) {
      const preview = await r.writer.previewIssue(symptom(variant));
      if (!preview.ok) {
        throw new Error(preview.code);
      }
      expect(keys.has(requestKey(preview.request_body)), variant).toBe(true);
    }
    for (const variant of CARD_CASES) {
      const preview = await r.writer.previewCard(cardSource(variant));
      if (!preview.ok) {
        throw new Error(preview.code);
      }
      expect(keys.has(requestKey(preview.request_body)), variant).toBe(true);
    }
  });
});

describe("the replay fetch", () => {
  const recording = makeRecording({
    requestBody: '{"model":"synthetic","messages":[]}',
    status: 200,
    responseBody: '{"synthetic":true}',
    provenance: "synthetic",
    recordedAt: "2026-10-05T00:00:00Z",
  });

  it("returns the recorded status and body for a matching request, whatever its key order", async () => {
    const replay = createReplayFetch([recording]);
    const response = await replay(URL_OK, { method: "POST", body: '{"messages":[],"model":"synthetic"}' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"synthetic":true}');
  });

  it("throws no_recording for an unmatched request and never forwards it", async () => {
    const replay = createReplayFetch([recording]);
    const error: unknown = await replay(URL_OK, { method: "POST", body: '{"model":"other"}' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(RequestNotSentError);
    expect((error as RequestNotSentError).code).toBe("no_recording");
  });

  it("refuses any URL other than the configured base URL", async () => {
    const replay = createReplayFetch([recording]);
    for (const url of ["https://synthetic.example.invalid/v1/chat/completions", "https://api.tokenfactory.nebius.com/v2/chat/completions"]) {
      const error: unknown = await replay(url, { method: "POST", body: '{"model":"synthetic","messages":[]}' }).catch(
        (thrown: unknown) => thrown,
      );
      expect((error as RequestNotSentError).code).toBe("unexpected_url");
    }
  });

  it("is what an unmatched writer call meets: the request is not sent and the call fails", async () => {
    const r = await rig(db);
    const outcome = await r.writer.writeIssue({ candidate: "synthetic-unrecorded", symptom: symptom("no-such-case"), excludedIdentifiers: [] });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.status).toBe("failed");
    expect(outcome.call.failure).toBe("request_not_sent");
    expect(outcome.call.settlement).toMatchObject({ state: "terminal" });
  });
});

describe("recording files", () => {
  it("store the request body without headers, the response, usage, model, time and provenance", () => {
    const rec = makeRecording({
      requestBody: '{"model":"synthetic"}',
      status: 200,
      responseBody: JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      provenance: "live",
      recordedAt: "2026-10-05T00:00:00Z",
    });
    expect(Object.keys(rec).sort()).toEqual(
      ["format_version", "model_id", "provenance", "recorded_at", "request", "request_sha256", "response", "usage"].sort(),
    );
    expect(rec.request).toEqual({ body: { model: "synthetic" } });
    expect(rec.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });

  it("refuse to load a file that carries headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synthetic-recordings-"));
    try {
      const rec = makeRecording({
        requestBody: "{}",
        status: 200,
        responseBody: "{}",
        provenance: "synthetic",
        recordedAt: "2026-10-05T00:00:00Z",
      });
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...rec, request: { ...rec.request, headers: { a: "b" } } }));
      await expect(loadRecordings(dir)).rejects.toThrow(/bad\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
