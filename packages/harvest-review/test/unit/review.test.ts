import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { profileSha256 } from "@rbw/writer";
import type { FetchFunction } from "@rbw/writer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateKey } from "../../src/review.ts";
import { runCommand } from "../../src/commands.ts";
import { KIMI_PROFILE, SUPER_PROFILE } from "../../src/profiles.ts";
import type { ReviewInputs } from "../../src/inputs.ts";
import {
  HARVEST_RUN,
  RATES,
  SLOT,
  SYNTHETIC_INPUTS,
  commandOptions,
  freshSpend,
  openDb,
  replayFetch,
  spyFetch,
  spySpend,
  syntheticInputs,
  tempDir,
} from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

interface CallResult {
  vote: string;
  call_name: string;
  operation_id: string;
  status: string;
  failure: string | null;
}
interface ReviewFile {
  context: Record<string, string>;
  stopped: { reason: string; operation_id: string | null } | null;
  counts: Record<string, number>;
  matrix: Record<string, Record<string, Record<string, number>>>;
  candidates: {
    candidate_id: string;
    candidate_key: string;
    outcome: string | null;
    reason: string | null;
    votes: { super: CallResult | null; kimi: CallResult | null };
  }[];
}

function readReview(out: string): ReviewFile {
  return JSON.parse(readFileSync(join(out, "review.json"), "utf8")) as ReviewFile;
}

function reviewArgs(inputs: string, out: string, extra: string[] = []): string[] {
  return ["review", "--inputs", inputs, "--rate-sheet", RATES, "--out", out, "--slot-key", SLOT, "--pool", "development", ...extra];
}

function writeInputs(inputs: ReviewInputs): string {
  const path = join(tempDir(), "review-inputs.json");
  writeFileSync(path, `${JSON.stringify(inputs, null, 2)}\n`);
  return path;
}

const short = (id: string): string => /synthetic-org\/(synthetic-[a-z-]+)/.exec(id)?.[1] ?? id;

describe("build-inputs", () => {
  it("writes the review inputs of a harvest run directory", async () => {
    const out = join(tempDir(), "review-inputs.json");
    const output: string[] = [];
    const spend = await freshSpend(db);
    const fail: FetchFunction = () => Promise.reject(new Error("no network in build-inputs"));
    const code = await runCommand(commandOptions(["build-inputs", "--run", HARVEST_RUN, "--out", out], spend, fail, output));
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(SYNTHETIC_INPUTS, "utf8"));
    expect(output.join("")).toContain("10 candidates");
  });
});

describe("review, end to end on PGlite with the replay fetch", () => {
  it("reviews the first 8 candidates with one reservation per call and combines the votes", async () => {
    const spy = spySpend(await freshSpend(db));
    const fetchSpy = spyFetch(await replayFetch());
    const out = join(tempDir(), "run");
    const output: string[] = [];
    const code = await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, out), spy.spend, fetchSpy.fetch, output));
    expect(code).toBe(0);

    const inputs = syntheticInputs();
    const keys = inputs.candidates.slice(0, 8).map((entry) => candidateKey(entry.candidate_id, entry.commit));
    expect(keys.every((key) => /^h[0-9a-f]{16}$/.test(key))).toBe(true);
    expect(spy.reserves.map((r) => r.call_name)).toEqual(keys.flatMap((key) => [`harvest.review:${key}:1`, `harvest.review:${key}:2`]));
    expect(spy.reserves.every((r) => r.kind === "harvest.review" && r.attempt_ordinal === 1)).toBe(true);
    expect(spy.reserves.every((r) => r.pool_key === "development")).toBe(true);
    const superReserve = spy.reserves[0];
    const kimiReserve = spy.reserves[1];
    expect(superReserve?.runtime_profile_sha256).toBe(profileSha256(SUPER_PROFILE));
    expect(kimiReserve?.runtime_profile_sha256).toBe(profileSha256(KIMI_PROFILE));
    expect(superReserve?.envelope.map((line) => [line.service, line.unit, line.limit])).toEqual([
      ["token-factory.nemotron-3-super", "input_token", 65_536],
      ["token-factory.nemotron-3-super", "output_token", 4_096],
    ]);
    expect(kimiReserve?.envelope.map((line) => [line.service, line.unit, line.limit])).toEqual([
      ["token-factory.kimi-k2.7-code", "input_token", 65_536],
      ["token-factory.kimi-k2.7-code", "output_token", 32_768],
    ]);

    expect(fetchSpy.bodies).toHaveLength(16);
    const [superBody, kimiBody] = fetchSpy.bodies;
    expect(superBody).toMatchObject({ model: "nvidia/nemotron-3-super-120b-a12b", max_tokens: 4_096, chat_template_kwargs: { enable_thinking: false } });
    expect(kimiBody).toMatchObject({ model: "moonshotai/Kimi-K2.7-Code", max_tokens: 32_768 });
    expect(kimiBody).not.toHaveProperty("chat_template_kwargs");
    expect(kimiBody).not.toHaveProperty("thinking");

    const review = readReview(out);
    expect(review.stopped).toBeNull();
    expect(review.candidates.map((entry) => [short(entry.candidate_id), entry.votes.super?.vote, entry.votes.kimi?.vote, entry.outcome])).toEqual([
      ["synthetic-sql", "yes", "yes", "confirmed"],
      ["synthetic-hook", "yes", "no", "needs_review"],
      ["synthetic-new-function", "yes", "yes", "needs_review"],
      ["synthetic-new-call", "no", "no", "model_rejected"],
      ["synthetic-already-passed", "unsure", "no", "needs_review"],
      ["synthetic-constant-zone", "unsure", "no", "needs_review"],
      ["synthetic-global-zone", "unsure", "yes", "needs_review"],
      ["synthetic-search-license", "no", "no", "model_rejected"],
      ["synthetic-backport", undefined, undefined, "not_reviewed"],
      ["synthetic-renamed", undefined, undefined, "not_reviewed"],
    ]);
    const passed = review.candidates[4]?.votes.super;
    expect([passed?.status, passed?.failure]).toEqual(["failed", "invalid_output"]);
    const http = review.candidates[5]?.votes.super;
    expect([http?.status, http?.failure]).toEqual(["failed", "http_status"]);
    expect(review.counts).toEqual({ confirmed: 1, model_rejected: 2, needs_review: 5, not_reviewed: 2 });
    expect(review.matrix.confirmed).toEqual({
      yes: { yes: 1, no: 1, unsure: 0 },
      no: { yes: 0, no: 1, unsure: 0 },
      unsure: { yes: 0, no: 0, unsure: 0 },
    });
    expect(review.matrix.dropped).toEqual({
      yes: { yes: 1, no: 0, unsure: 0 },
      no: { yes: 0, no: 1, unsure: 0 },
      unsure: { yes: 1, no: 2, unsure: 0 },
    });
    expect(review.context.parent_execution_id).toBe(review.context.root_execution_id);
    expect(readdirSync(join(out, "recordings"))).toHaveLength(16);
    expect(output.join("")).toContain("confirmed 1, model_rejected 2, needs_review 5, not_reviewed 2");

    const slot = await spy.spend.slotStatus({ slot_key: SLOT });
    expect(slot.ok && slot.holder).toBeNull();
  });

  it("reviews the candidates past the cap in a second run over the rest of the inputs", async () => {
    const inputs = syntheticInputs();
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "run");
    const code = await runCommand(commandOptions(reviewArgs(writeInputs({ ...inputs, candidates: inputs.candidates.slice(8) }), out), spy.spend, await replayFetch(), []));
    expect(code).toBe(0);
    const review = readReview(out);
    expect(review.candidates.map((entry) => [short(entry.candidate_id), entry.votes.super?.vote, entry.votes.kimi?.vote, entry.outcome])).toEqual([
      ["synthetic-backport", "yes", "yes", "confirmed"],
      ["synthetic-renamed", "yes", "unsure", "needs_review"],
    ]);
    expect(spy.reserves).toHaveLength(4);
  });

  it("makes a fresh run context, so a second run over the same inputs reserves cleanly", async () => {
    const spy = spySpend(await freshSpend(db));
    const fetch = await replayFetch();
    const first = join(tempDir(), "first");
    const second = join(tempDir(), "second");
    expect(await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, first), spy.spend, fetch, []))).toBe(0);
    expect(await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, second), spy.spend, fetch, []))).toBe(0);
    const [a, b] = [readReview(first).context, readReview(second).context];
    for (const field of ["batch_id", "root_execution_id", "execution_id"]) {
      expect(a[field]).not.toBe(b[field]);
    }
    expect(spy.reserves).toHaveLength(32);
    expect(new Set(spy.reserves.map((r) => r.operation_id)).size).toBe(32);
    expect(readReview(second).counts).toEqual(readReview(first).counts);
  });

  it("sends nothing for a candidate whose request is over the input limit, and marks it too_large", async () => {
    const inputs = syntheticInputs();
    const [first] = inputs.candidates;
    if (first === undefined) {
      throw new Error("no synthetic candidate");
    }
    const huge = { ...first, candidate_id: "synthetic-org/synthetic-huge#1", after: { ...first.after, text: `${first.after.text}\n${"x".repeat(70_000)}` } };
    const spy = spySpend(await freshSpend(db));
    const fetchSpy = spyFetch(await replayFetch());
    const out = join(tempDir(), "run");
    const code = await runCommand(commandOptions(reviewArgs(writeInputs({ ...inputs, candidates: [huge, first] }), out), spy.spend, fetchSpy.fetch, []));
    expect(code).toBe(0);
    const review = readReview(out);
    expect(review.candidates.map((entry) => [entry.outcome, entry.reason, entry.votes.super, entry.votes.kimi === null])).toEqual([
      ["needs_review", "too_large", null, true],
      ["confirmed", null, expect.objectContaining({ vote: "yes" }), false],
    ]);
    expect(spy.reserves).toHaveLength(2);
    expect(fetchSpy.bodies).toHaveLength(2);
  });

  it("reviews at most 8 candidates and marks the rest not_reviewed", async () => {
    const inputs = syntheticInputs();
    const [first] = inputs.candidates;
    if (first === undefined) {
      throw new Error("no synthetic candidate");
    }
    const many = Array.from({ length: 9 }, (_unused, index) => ({ ...first, candidate_id: `synthetic-org/synthetic-copy#${String(index + 1)}` }));
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "run");
    const code = await runCommand(commandOptions(reviewArgs(writeInputs({ ...inputs, candidates: many }), out), spy.spend, await replayFetch(), []));
    expect(code).toBe(0);
    const review = readReview(out);
    expect(review.candidates.map((entry) => entry.outcome)).toEqual([...Array<string>(8).fill("confirmed"), "not_reviewed"]);
    expect(review.counts).toEqual({ confirmed: 8, model_rejected: 0, needs_review: 0, not_reviewed: 1 });
    expect(spy.reserves).toHaveLength(16);
  });

  it("takes a lower --max-candidates and refuses one above 8", async () => {
    const spy = spySpend(await freshSpend(db));
    const out = join(tempDir(), "run");
    expect(await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, out, ["--max-candidates", "2"]), spy.spend, await replayFetch(), []))).toBe(0);
    expect(readReview(out).counts).toEqual({ confirmed: 1, model_rejected: 0, needs_review: 1, not_reviewed: 8 });
    expect(spy.reserves).toHaveLength(4);

    const output: string[] = [];
    const refused = await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, join(tempDir(), "run"), ["--max-candidates", "9"]), spy.spend, await replayFetch(), output));
    expect(refused).toBe(2);
    expect(output.join("")).toContain("--max-candidates");
    expect(spy.reserves).toHaveLength(4);
  });

  it("stops at an uncertain call, writing what is known and leaving the slot held", async () => {
    const spy = spySpend(await freshSpend(db));
    const lost: FetchFunction = () => Promise.reject(new Error("synthetic connection reset"));
    const out = join(tempDir(), "run");
    const output: string[] = [];
    const code = await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, out), spy.spend, lost, output));
    expect(code).toBe(1);
    expect(spy.reserves).toHaveLength(1);
    const review = readReview(out);
    const operation = spy.reserves[0]?.operation_id ?? "";
    expect(review.stopped).toMatchObject({ reason: "uncertain", operation_id: operation });
    expect(review.candidates[0]?.votes.super).toMatchObject({ status: "uncertain", vote: "unsure" });
    expect(review.candidates[0]?.outcome).toBeNull();
    expect(review.candidates.slice(1, 8).every((entry) => entry.outcome === null && entry.votes.super === null)).toBe(true);
    expect(review.candidates.slice(8).map((entry) => entry.outcome)).toEqual(["not_reviewed", "not_reviewed"]);
    const status = await spy.spend.operationStatus({ operation_id: operation });
    expect(status.ok && status.state).toBe("uncertain");
    const slot = await spy.spend.slotStatus({ slot_key: SLOT });
    expect(slot.ok && slot.holder).toBe(review.context.root_execution_id);
    expect(output.join("")).toContain(operation);
  });

  it("reads both variables from the environment and refuses to run without them", async () => {
    const spend = await freshSpend(db);
    for (const missing of ["DATABASE_URL", "TOKEN_FACTORY_REVIEW_KEY"]) {
      const output: string[] = [];
      const options = commandOptions(reviewArgs(SYNTHETIC_INPUTS, join(tempDir(), "run")), spend, await replayFetch(), output);
      const code = await runCommand({ ...options, env: { ...options.env, [missing]: undefined } });
      expect(code).toBe(1);
      expect(output.join("")).toContain(`${missing} is not set`);
    }
  });

  it("refuses an output directory that is not new", async () => {
    const spy = spySpend(await freshSpend(db));
    const out = tempDir();
    writeFileSync(join(out, "synthetic.txt"), "synthetic\n");
    const output: string[] = [];
    expect(await runCommand(commandOptions(reviewArgs(SYNTHETIC_INPUTS, out), spy.spend, await replayFetch(), output))).toBe(1);
    expect(spy.reserves).toHaveLength(0);
  });
});
