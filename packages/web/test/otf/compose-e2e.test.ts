// The composed OTF server end to end, with no network: the customer routes (through their route
// modules, which load compose.ts) get the composition's dependencies over the in-memory store, a
// fake power port and a fake clock, and the builder routes run on the same store with HMAC-signed
// requests. Every value is invented: models, lanes, builder ids, spec text and bundle bytes.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as availabilityRoute } from "../../app/api/factory/otf/availability/route.ts";
import { GET as artifactRoute } from "../../app/api/factory/otf/jobs/[id]/artifacts/[part]/route.ts";
import { GET as statusRoute } from "../../app/api/factory/otf/jobs/[id]/route.ts";
import { POST as createRoute } from "../../app/api/factory/otf/jobs/route.ts";
import { loadOtfConfig, type OtfConfig } from "../../src/config.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { builderHeaders } from "../../src/otf/builder-auth.ts";
import { postClaim, postEvents, postResult, type OtfBuilderDeps } from "../../src/otf/builder-handlers.ts";
import { specSha256 } from "../../src/otf/canonical.ts";
import {
  OTF_LIFECYCLE,
  OtfNotConfiguredError,
  liveOtfCustomerDependencies,
  otfBehaviors,
  otfCustomerDependencies,
  otfCustomerLoader,
} from "../../src/otf/compose.ts";
import {
  AGENT_LABEL,
  CERTIFICATE_FORMAT,
  CERTIFICATE_RUNNER,
  COPY_LIMITS,
  EXPECTED_CELLS,
  TOKEN_FACTORY_PROVIDER,
  type BuilderEventIn,
  type NebiusInstanceState,
  type OtfCertificate,
  type OtfCreateJob,
  type OtfSpecCard,
  type ResultPost,
  type VmPower,
} from "../../src/otf/contract.ts";
import { calendarReason, setOtfCustomerDependencies } from "../../src/otf/handlers.ts";
import { requestStart as lifecycleRequestStart } from "../../src/otf/power/lifecycle.ts";
import { parseOtf, type OtfBodies, type OtfSchemaName } from "../../src/otf/schemas.ts";
import { createMemoryOtfStore, type MemoryOtfStore } from "../../src/otf/store.ts";

const PASSCODE = "synthetic-compose-passcode";
const SECRET = "synthetic-compose-builder-secret-0123456789";
const BUILDER = "synthetic-builder-1";
const JOB = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const LANES = [
  { model: "synthetic/model-a", model_label: "Synthetic A", price_in_usd_per_m: "0.10", price_out_usd_per_m: "0.40" },
  { model: "synthetic/model-b", model_label: "Synthetic B", price_in_usd_per_m: "0.05", price_out_usd_per_m: "0.20" },
];
const UMAMI_LANES = [{ model: "synthetic/model-c", model_label: "Synthetic C", price_in_usd_per_m: "0.07", price_out_usd_per_m: "0.30" }];
const ENV = {
  DATABASE_URL: "postgres://synthetic.invalid/otf",
  RBW_OTF_BUILDER_SECRET: SECRET,
  RBW_JUDGE_PASSCODE: PASSCODE,
  RBW_OTF_LANES: JSON.stringify(LANES),
  RBW_OTF_UMAMI_LANES: JSON.stringify(UMAMI_LANES),
  RBW_NEBIUS_SA_ID: "synthetic-service-account",
  RBW_NEBIUS_SA_KEY_ID: "synthetic-key-id",
  RBW_NEBIUS_SA_PRIVATE_KEY: "synthetic-private-key",
  RBW_NEBIUS_VM_ID: "synthetic-instance",
};
const SPEC: OtfSpecCard = {
  title: "Synthetic overlapping saves",
  where: "The task save component.",
  change: "An overlapping save replaces an earlier saved edit.",
  why_tests_miss: "The original suite saves one edit at a time.",
  checks_to_add: ["Both overlapping saves remain visible."],
  fix: "Serialize overlapping saves.",
};
const UMAMI_SPEC: OtfSpecCard = {
  title: "Synthetic daily totals",
  where: "The daily totals of the reports view.",
  change: "Daily totals group events by the server's time zone.",
  why_tests_miss: "The original suite runs in UTC only.",
  checks_to_add: ["A late evening event counts on the viewer's day."],
  fix: "Group by the viewer's time zone.",
};

class FakePower implements VmPower {
  state: NebiusInstanceState = "STOPPED";
  starts = 0;
  get(): Promise<{ state: NebiusInstanceState; preset: string }> {
    return Promise.resolve({ state: this.state, preset: "synthetic-preset" });
  }
  start(): Promise<{ operation_id: string }> {
    this.starts += 1;
    this.state = "STARTING";
    return Promise.resolve({ operation_id: "synthetic-start" });
  }
  stop(): Promise<{ operation_id: string }> {
    this.state = "STOPPED";
    return Promise.resolve({ operation_id: "synthetic-stop" });
  }
}

interface World {
  store: MemoryOtfStore;
  power: FakePower;
  otf: OtfConfig;
  builder: OtfBuilderDeps;
  requestStart: ReturnType<typeof vi.fn>;
  advance(ms: number): void;
  now(): Date;
}

/** Installs the composition's dependencies over the memory store, a fake power port and this clock. */
function world(startIso: string): World {
  let clock = Date.parse(startIso);
  const now = (): Date => new Date(clock);
  const store = createMemoryOtfStore({ now });
  const power = new FakePower();
  const otf = loadOtfConfig(ENV);
  const requestStart = vi.fn(lifecycleRequestStart);
  const deps = otfCustomerDependencies({ otf, passcode: PASSCODE, store, power, now });
  setOtfCustomerDependencies(() => Promise.resolve({ ...deps, lifecycle: { ...OTF_LIFECYCLE, requestStart }, id: () => JOB }));
  return {
    store,
    power,
    otf,
    requestStart,
    advance(ms) {
      clock += ms;
    },
    now,
    builder: {
      store,
      config: otf,
      now,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      log: () => undefined,
      claimHoldMs: 0,
    },
  };
}

function customer(path: string, value?: unknown): Request {
  return new Request(`https://synthetic.invalid${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: { cookie: factorySessionCookie(PASSCODE), "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

function signed(w: World, path: string, body: unknown): Request {
  const text = JSON.stringify(body);
  const headers = builderHeaders(SECRET, BUILDER, w.now().getTime(), "POST", path, text);
  return new Request(`https://synthetic.invalid${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: text });
}

async function parsed<N extends OtfSchemaName>(schema: N, response: Response): Promise<OtfBodies[N]> {
  const value: unknown = await response.json();
  const result = parseOtf(schema, value);
  if (!result.ok) throw new Error(`The response does not match ${schema}: ${result.errors.join("; ")}`);
  return result.value;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function createBody(host: "task-report" | "umami" = "task-report"): Promise<OtfCreateJob> {
  const spec = host === "umami" ? UMAMI_SPEC : SPEC;
  return {
    client_key: CLIENT,
    host_id: host,
    criterion_id: host === "umami" ? "date_time.time-zone-grouping" : "concurrency.lost-acknowledged-change",
    sentence: host === "umami" ? "Daily totals land on the wrong day." : "Overlapping saves lose my edit.",
    spec,
    spec_sha256: await specSha256(spec),
  };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** An invented delivery for the job: two gzip bundles and a certificate bound to them. */
function delivery(w: World, specSha: string): { post: ResultPost; agent: Uint8Array; grader: Uint8Array } {
  const agent = new Uint8Array(gzipSync("synthetic agent bundle"));
  const grader = new Uint8Array(gzipSync("synthetic grader bundle"));
  const at = w.now().toISOString();
  const certificate: OtfCertificate = {
    format: CERTIFICATE_FORMAT,
    job_id: JOB,
    host_id: "task-report",
    app_base_commit: "c".repeat(40),
    criterion: { criterion_id: "concurrency.lost-acknowledged-change", version: "1", failure_code: "synthetic-failure" },
    spec_sha256: specSha,
    designer: { model: "synthetic/designer", route: "bug-spec" },
    implementer: { lane_id: "lane-1", agent: AGENT_LABEL, provider: TOKEN_FACTORY_PROVIDER, model: "synthetic/model-a", rounds_used: 1 },
    qualification: { cells: EXPECTED_CELLS, confirmation_cells: EXPECTED_CELLS, admission: null, result: "qualified" },
    harness: { tier: "B", kit_image_id: "sha256:synthetic", copy_limits: COPY_LIMITS, instances: { clean: 1, buggy: 3, fixed: 3 }, runner: CERTIFICATE_RUNNER, harness_sha256: "d".repeat(64) },
    bundles: { agent_sha256: sha(agent), grader_sha256: sha(grader) },
    spend: { model_microusd: 500_000, tokens_in: 10, tokens_out: 20, lanes: 2 },
    timings: { started_at: at, qualified_at: at, wall_ms: 300_000 },
    issued_at: at,
    builder_revision: "synthetic-revision",
    received: null,
  };
  const certificateBytes = new TextEncoder().encode(JSON.stringify(certificate));
  const part = (name: "agent" | "grader" | "certificate", filename: string, bytes: Uint8Array) => ({ part: name, filename, sha256: sha(bytes), size: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") });
  const job8 = JOB.slice(0, 8);
  return {
    agent,
    grader,
    post: {
      builder_id: BUILDER,
      outcome: "delivered",
      reason: null,
      certificate,
      parts: [part("agent", `rbw-otf-agent-${job8}.tar.gz`, agent), part("grader", `rbw-otf-grader-${job8}.tar.gz`, grader), part("certificate", `rbw-otf-certificate-${job8}.json`, certificateBytes)],
    },
  };
}

afterEach(() => {
  // Back to the composition's own loader.
  setOtfCustomerDependencies(otfCustomerLoader());
});

describe("the composed OTF server", () => {
  it("delivers a task-report job: create, a signed claim, lane events, the result, then both downloads by sha256", async () => {
    const w = world("2026-10-29T12:00:00.000Z");
    const body = await createBody();
    const created = await createRoute(customer("/api/factory/otf/jobs", body));
    expect(created.status).toBe(201);
    const first = await parsed("OtfCreateResponse", created);
    expect(first.job_id).toBe(JOB);
    expect(first.status.state).toBe("starting_builder");
    expect(first.status.events.map((event) => event.type)).toEqual(["job_queued", "builder_starting"]);
    expect(w.requestStart).toHaveBeenCalledTimes(1);
    expect(w.power.starts).toBe(1);

    // The machine boots; the builder's first signed claim takes the job.
    w.advance(90_000);
    w.power.state = "RUNNING";
    const claim = await postClaim(
      signed(w, "/api/factory/otf/builder/claim", {
        builder_id: BUILDER,
        builder_revision: "synthetic-revision",
        boot_id: "synthetic-boot",
        booted_at: new Date(w.now().getTime() - 30_000).toISOString(),
        images_ok: true,
        free: { build: { "task-report": 1, umami: 1 }, validate: { "task-report": 1, umami: 1 } },
        ready_hosts: ["task-report", "umami"],
      }),
      w.builder,
    );
    expect(claim.status).toBe(200);
    const reply = await parsed("ClaimReply", claim);
    expect(reply.job).toMatchObject({ kind: "build", job_id: JOB, host_id: "task-report", lanes: LANES.map((lane, index) => ({ lane_id: `lane-${String(index + 1)}`, ...lane })) });

    w.advance(60_000);
    const at = (s: number): string => new Date(w.now().getTime() - 60_000 + s * 1_000).toISOString();
    const events: BuilderEventIn[] = [
      { type: "lane_started", lane_id: "lane-1", data: { model: "synthetic/model-a", model_label: "Synthetic A", agent: AGENT_LABEL }, builder_seq: 1, at: at(1) },
      { type: "lane_stage", lane_id: "lane-1", data: { stage: "writing", iteration: 1 }, builder_seq: 2, at: at(2) },
      { type: "lane_meter", lane_id: "lane-1", data: { tokens_in: 10, tokens_out: 20, requests: 1, cost_microusd: 500_000 }, builder_seq: 3, at: at(3) },
      { type: "winner_selected", lane_id: null, data: { lane_id: "lane-1", candidate_id: "synthetic-candidate", qualified_at_iteration: 1 }, builder_seq: 4, at: at(4) },
    ];
    const posted = await postEvents(signed(w, `/api/factory/otf/builder/jobs/${JOB}/events`, { builder_id: BUILDER, events }), w.builder, { job_id: JOB });
    expect(posted.status).toBe(200);
    expect(await parsed("EventsReply", posted)).toMatchObject({ accepted_through: 4 });

    w.advance(30_000);
    const { post, agent, grader } = delivery(w, body.spec_sha256);
    const result = await postResult(signed(w, `/api/factory/otf/builder/jobs/${JOB}/result`, post), w.builder, { job_id: JOB });
    expect(result.status).toBe(200);
    expect(await parsed("ResultReply", result)).toEqual({ job_id: JOB, state: "finished", outcome: "delivered" });

    const status = await parsed("OtfJobStatus", await statusRoute(customer(`/api/factory/otf/jobs/${JOB}?after=0`), { params: Promise.resolve({ id: JOB }) }));
    expect(status).toMatchObject({ state: "finished", outcome: "delivered", winner: { lane_id: "lane-1", model: "synthetic/model-a" } });
    expect(status.certificate?.received?.sha256_verified).toBe(true);
    expect(status.events.map((event) => event.type)).toEqual(["job_queued", "builder_starting", "builder_ready", "job_claimed", "lane_started", "lane_stage", "lane_meter", "winner_selected", "job_finished"]);
    const listed = new Map(status.artifacts.map((artifact) => [artifact.part, artifact]));
    for (const [part, bytes] of [["agent", agent], ["grader", grader]] as const) {
      const artifact = listed.get(part);
      expect(artifact?.sha256).toBe(sha(bytes));
      const download = await artifactRoute(customer(artifact?.download_path ?? ""), { params: Promise.resolve({ id: JOB, part }) });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/gzip");
      const received = new Uint8Array(await download.arrayBuffer());
      expect(sha(received)).toBe(artifact?.sha256);
    }
  });

  it("refuses a Umami create host_unavailable on a blocked UTC day and stores no job", async () => {
    const w = world("2026-11-03T12:00:00.000Z");
    const refused = await createRoute(customer("/api/factory/otf/jobs", await createBody("umami")));
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("host_unavailable");
    expect(await w.store.listJobs(["queued", "starting_builder", "building", "finished"])).toEqual([]);
    expect(w.requestStart).not.toHaveBeenCalled();
    const availability = await parsed("OtfAvailability", await availabilityRoute(customer("/api/factory/otf/availability")));
    expect(availability.hosts.find((host) => host.host_id === "umami")).toMatchObject({ offered: false, unavailable_reason: "calendar" });
    expect(availability.hosts.find((host) => host.host_id === "task-report")).toMatchObject({ offered: true, unavailable_reason: null });
    expect(availability.behaviors.map((behavior) => behavior.host_id)).toEqual(["task-report", "task-report"]);
    expect(calendarReason("umami")).toBe("Umami is unavailable on UTC days 2–5.");
  });

  it("starts a stopped builder for a create: requestStart runs and builder_starting is appended", async () => {
    const w = world("2026-10-29T12:00:00.000Z");
    await w.store.withPowerLock(() => Promise.resolve({ patch: { state: "stopped", instance_state: "STOPPED", preset: "synthetic-preset", since: w.now().toISOString() }, log: [], result: null }));
    const created = await createRoute(customer("/api/factory/otf/jobs", await createBody()));
    expect(created.status).toBe(201);
    expect(w.requestStart).toHaveBeenCalledTimes(1);
    expect(w.power.starts).toBe(1);
    expect((await w.store.getPower()).state).toBe("starting");
    const events = await w.store.listEvents(JOB, 0);
    expect(events.map((event) => event.type)).toEqual(["job_queued", "builder_starting"]);
    expect(events[1]).toMatchObject({ data: { preset: "synthetic-preset", requested_at: w.now().toISOString() } });
  });

  it("lists the factory catalog's criteria as the offered behaviors", () => {
    expect(otfBehaviors().map((behavior) => [behavior.criterion_id, behavior.host_id])).toEqual([
      ["concurrency.lost-acknowledged-change", "task-report"],
      ["concurrency.stale-success-response", "task-report"],
      ["date_time.time-zone-grouping", "umami"],
    ]);
    for (const behavior of otfBehaviors()) {
      expect(behavior.label.length).toBeGreaterThan(0);
      expect(behavior.example_phrases.length).toBeGreaterThan(0);
    }
  });

  it("fails closed: with a required variable unset every customer route answers unavailable", async () => {
    for (const unset of ["DATABASE_URL", "RBW_OTF_BUILDER_SECRET", "RBW_JUDGE_PASSCODE", "RBW_NEBIUS_VM_ID"] as const) {
      const env = Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== unset));
      await expect(liveOtfCustomerDependencies(env)).rejects.toThrow(OtfNotConfiguredError);
      await expect(liveOtfCustomerDependencies(env)).rejects.toThrow(unset);
      setOtfCustomerDependencies(otfCustomerLoader(env));
      const availability = await availabilityRoute(customer("/api/factory/otf/availability"));
      expect(availability.status).toBe(503);
      expect(await errorCode(availability)).toBe("unavailable");
      const create = await createRoute(customer("/api/factory/otf/jobs", await createBody()));
      expect(create.status).toBe(503);
    }
    const env: Record<string, string> = { ...ENV };
    delete env.RBW_OTF_LANES;
    delete env.RBW_OTF_UMAMI_LANES;
    await expect(liveOtfCustomerDependencies(env)).rejects.toThrow("RBW_OTF_LANES or RBW_OTF_UMAMI_LANES");
  });
});
