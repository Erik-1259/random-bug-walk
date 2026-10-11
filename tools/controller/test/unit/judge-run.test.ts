import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";
import { parseCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { JobRequest, Release } from "@rbw/schema";
import type { Spend } from "@rbw/spend";
import { controllerEnvelope } from "../../src/envelope.ts";
import type { CopyEnvelope } from "../../src/envelope.ts";
import { controllerSandboxName, judgeDeadlineMs, judgeIds, judgeKeys, judgeOperation, judgeRelease, newProgress, parseProgress, progressBytes } from "../../src/judge.ts";
import { NO_DOCKER, runJudgeReplay } from "../../src/judge-run.ts";
import { JUDGE } from "../../src/limits.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";
import { tempDir, writeAlternativeDir, writeProbeDir } from "../../../local-runner/test/support/synthetic.ts";
import { world } from "../support/harness.ts";
import type { World } from "../support/harness.ts";

const FIXTURE = fileURLToPath(new URL("../../../release/fixtures/release/", import.meta.url));
const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
const REQUEST_ID = "00000000-0000-4000-8000-00000000b101";
const CREATED = Date.parse("2026-10-06T09:00:00Z");

interface Replay {
  w: World;
  release: Release;
  store: PrivateStore;
  storeDir: string;
  events: string[];
  root: string;
  operationId: string;
}

function releaseRecord(): Release {
  return parseRecord("Release", readFileSync(join(FIXTURE, "repository", "releases", RELEASE_ID, "release.json")));
}

/** The private store as the route leaves it: the fixture's judge job, root-run.json prepared and progress.json. */
async function prepare(options: { startAfterMs?: number; release?: Release; corrupt?: string } = {}): Promise<Replay> {
  const events: string[] = [];
  const clock = new FakeClock({ start: CREATED });
  const w = await world({ clock, sandbox: { collected: { runExit: 0 }, onStop: () => events.push("sdk:stop") } });
  const release = options.release ?? releaseRecord();
  const storeDir = tempDir("rbw-judge-store-");
  cpSync(join(FIXTURE, "private-store"), storeDir, { recursive: true });
  if (options.corrupt !== undefined) writeFileSync(join(storeDir, "judge-jobs", RELEASE_ID, options.corrupt), "synthetic corrupted bytes\n");
  const inner = new LocalPrivateStore(storeDir);
  const store: PrivateStore = {
    putNew: (key, bytes, type) => inner.putNew(key, bytes, type),
    put: (key, bytes, type) => {
      events.push(`put:${key.split("/").slice(2).join("/")}`);
      return inner.put(key, bytes, type);
    },
    get: (key, max) => inner.get(key, max),
    list: (prefix) => inner.list(prefix),
  };
  const ids = judgeIds(REQUEST_ID);
  const op = judgeOperation(REQUEST_ID, judgeRelease(release), controllerEnvelope(w.deps.rates) as CopyEnvelope);
  const must = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error("synthetic: the route's ledger setup was refused");
  };
  must(await w.spend.acquireSlot({ slot_key: JUDGE.slot_key, root_execution_id: ids.root, actor_role: "judge-route" }));
  must(await w.spend.reserve(op.request));
  must(await w.spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: "judge-route", slot_key: JUDGE.slot_key }));
  must(await w.spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "running", actor_role: "judge-route", provider_resource_id: op.sandbox_name }));
  const keys = judgeKeys(ids.root);
  await inner.putNew(keys.progress, progressBytes(newProgress(ids.root, CREATED, judgeDeadlineMs(CREATED))), "application/json");
  w.sdk.seed(controllerSandboxName(ids.root), "running");
  clock.current = CREATED + (options.startAfterMs ?? 30_000);
  const spend = w.deps.spend;
  const noted: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(spend) as [string, (request: { to_state?: string; operation_id?: string }) => Promise<unknown>][]) {
    noted[name] = (request: { to_state?: string; operation_id?: string }) => {
      const mine = request.operation_id === op.operation_id ? ":controller" : "";
      events.push(`ledger:${name}${request.to_state === undefined ? "" : `:${request.to_state}`}${mine}`);
      return fn(request);
    };
  }
  w.deps.spend = noted as unknown as Spend;
  w.deps.docker = NO_DOCKER;
  return { w, release, store, storeDir, events, root: ids.root, operationId: op.operation_id };
}

function run(r: Replay, deadlineAtMs = judgeDeadlineMs(CREATED)) {
  return runJudgeReplay(
    { requestId: REQUEST_ID, release: r.release, store: r.store, deadlineAtMs, work: tempDir("rbw-judge-work-"), probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() },
    r.w.deps,
  );
}

async function get(r: Replay, key: string): Promise<Uint8Array> {
  const bytes = await r.store.get(key, 64 * 1024 * 1024);
  if (bytes === null) throw new Error(`synthetic: no ${key}`);
  return bytes;
}

async function ledgerState(r: Replay) {
  const op = await r.w.spend.operationStatus({ operation_id: r.operationId });
  const slot = await r.w.spend.slotStatus({ slot_key: JUDGE.slot_key });
  if (!op.ok || !slot.ok) throw new Error("synthetic: no status");
  return { op, slot };
}

describe("prebuilt mode: a judge replay from the frozen judge job, with no Docker", () => {
  it("runs the three copies on the Sandbox backend and completes, not needs_reconciliation", async () => {
    const r = await prepare();
    const outcome = await run(r);
    expect(outcome.summary.status).toBe("complete");
    expect(outcome.summary.reason).toBeNull();
    expect(outcome.summary.copies.map((copy) => `${copy.trial_id} ${copy.status} ${copy.launch}`)).toEqual(["clean-01 complete confirmed", "planted-01 complete confirmed", "fixed-01 complete confirmed"]);
    expect(r.w.sdk.ops().filter((op) => op === "create")).toHaveLength(3);
    expect(r.w.deps.docker).toBe(NO_DOCKER);
  });

  it("overlays the request ID's root, the release and the passed deadline on the frozen request", async () => {
    const r = await prepare();
    const outcome = await run(r);
    const request = parseCanonical(readFileSync(join(outcome.jobDir, "job", "request.json"))) as unknown as JobRequest;
    const ids = judgeIds(REQUEST_ID);
    expect(request.root_execution_id).toBe(ids.root);
    expect(request.execution_id).toBe(ids.execution);
    expect(request.release_id).toBe(RELEASE_ID);
    expect(request.deadline_at).toBe("2026-10-06T09:33:00Z");
    const frozen = parseCanonical(readFileSync(join(FIXTURE, "private-store", "judge-jobs", RELEASE_ID, "request.json"))) as unknown as JobRequest;
    expect(request.reservation_microusd).toBe(frozen.reservation_microusd);
    expect(outcome.summary.job.root_execution_id).toBe(ids.root);
  });

  it("acquires the slot as a holder replay of the route's hold", async () => {
    const r = await prepare();
    await run(r);
    const acquire = r.w.ledgerCalls.filter((call) => call.method === "acquireSlot");
    expect(acquire).toHaveLength(1);
    expect(acquire[0]?.ok).toBe(true);
    expect((acquire[0]?.request as { root_execution_id: string }).root_execution_id).toBe(r.root);
  });

  it("audits the planted copy with the stored audit inputs; clean and fixed are not_applicable", async () => {
    const r = await prepare();
    const outcome = await run(r);
    const audits = Object.fromEntries(outcome.summary.copies.map((copy) => [copy.trial_id, copy.copy?.audit.verdict]));
    expect(audits).toEqual({ "clean-01": "not_applicable", "planted-01": "pass", "fixed-01": "not_applicable" });
  });

  it("writes the final progress and the terminal root-run before closing its own operation, settles it in full, then releases the slot, then stops its sandbox", async () => {
    const r = await prepare();
    const outcome = await run(r);
    const at = (event: string) => r.events.lastIndexOf(event);
    expect(at("put:root-run.json")).toBeGreaterThan(-1);
    expect(at("put:progress.json")).toBeLessThan(at("ledger:transition:terminal:controller"));
    expect(at("put:root-run.json")).toBeLessThan(at("ledger:transition:terminal:controller"));
    expect(at("put:run/jobs/judge/summary.json")).toBeLessThan(at("ledger:transition:terminal:controller"));
    expect(at("ledger:transition:terminal:controller")).toBeLessThan(at("ledger:settle:controller"));
    expect(at("ledger:settle:controller")).toBeLessThan(at("ledger:releaseSlot"));
    expect(r.events.filter((event) => event === "ledger:releaseSlot")).toHaveLength(1);
    expect(r.events.at(-1)).toBe("sdk:stop");
    expect(r.w.sdk.calls.at(-1)).toEqual({ op: "stop", name: controllerSandboxName(r.root) });
    const { op, slot } = await ledgerState(r);
    expect(op.state).toBe("reconciled");
    expect(op.settled_microusd).toBe(op.reserved_microusd);
    expect(slot.holder).toBeNull();
    expect(outcome.state === "verified" || outcome.state === "not_reproduced").toBe(true);
  });

  it("lays out judge/<root>/ as publish-replays reads it, with no copy work directories or source", async () => {
    const r = await prepare();
    const outcome = await run(r);
    const keys = await r.store.list(`judge/${r.root}/`);
    const relative = keys.map((key) => key.slice(`judge/${r.root}/`.length));
    expect(relative).toContain("root-run.json");
    expect(relative).toContain("progress.json");
    for (const name of ["summary.json", "evidence.json", "decision.json", "job/request.json", "records/request.json"]) expect(relative).toContain(`run/jobs/judge/${name}`);
    expect(relative.every((path) => ["root-run.json", "progress.json"].includes(path) || /^run\/jobs\/judge\/(summary\.json|evidence\.json|decision\.json|job\/|records\/)/.test(path))).toBe(true);
    const root = parseRecord("RootRun", await get(r, `judge/${r.root}/root-run.json`));
    expect(root).toMatchObject({ kind: "judge_replay", status: "terminal", outcome: "completed", root_execution_id: r.root, child_execution_ids: [judgeIds(REQUEST_ID).execution], project_id: r.release.project_id });
    const progress = parseProgress(await get(r, `judge/${r.root}/progress.json`));
    expect(progress.created_at).toBe("2026-10-06T09:00:00Z");
    expect(progress.deadline_at).toBe("2026-10-06T09:33:00Z");
    expect(progress.state).toBe(outcome.state);
    expect(progress.known_condition).toBe(false);
    expect(progress.copies.map((copy) => copy.status)).toEqual(["done", "done", "done"]);
    expect(progress.ended_at).not.toBeNull();
  });

  it("counts from the passed deadline: a controller starting 300 s after the create has 1,680 s", async () => {
    const r = await prepare({ startAfterMs: 300_000 });
    const outcome = await run(r);
    expect(Date.parse(outcome.summary.job.deadline_at ?? "") - Date.parse(outcome.summary.controller.started_at)).toBe(1_680_000);
  });
});

describe("prebuilt mode: a frozen judge job that does not match", () => {
  async function mismatch(r: Replay) {
    const outcome = await run(r);
    expect(outcome.summary.reason).toBe("judge_job_mismatch");
    expect(r.w.ledgerCalls.filter((call) => call.method === "reserve")).toHaveLength(0);
    expect(r.w.sdk.ops().filter((op) => op === "create")).toHaveLength(0);
    const { op, slot } = await ledgerState(r);
    expect(op.state).toBe("reconciled");
    expect(op.settled_microusd).toBe(op.reserved_microusd);
    expect(slot.holder).toBeNull();
    const root = parseRecord("RootRun", await get(r, `judge/${r.root}/root-run.json`));
    expect(root.status).toBe("terminal");
    expect(parseProgress(await get(r, `judge/${r.root}/progress.json`)).state).toBe("incomplete");
    expect(r.events.indexOf("put:root-run.json")).toBeLessThan(r.events.indexOf("ledger:transition:terminal:controller"));
    const summary = parseCanonical(await get(r, `judge/${r.root}/run/jobs/judge/summary.json`)) as unknown as { job: { execution_id: string } };
    expect(summary.job.execution_id).toBe(judgeIds(REQUEST_ID).execution);
  }

  it("refuses an index whose hash is not the release's, with no copy operations, and still closes its own operation", async () => {
    const release = releaseRecord();
    await mismatch(await prepare({ release: { ...release, judge_job: { ...release.judge_job, index_sha256: sha256Hex(Buffer.from("synthetic other index")) } } }));
  });

  it("refuses a file whose hash is not the index's", async () => {
    await mismatch(await prepare({ corrupt: "strict-terms.txt" }));
  });
});
