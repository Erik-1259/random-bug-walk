// Synthetic end-to-end proof: real customer handlers, lifecycle and memory store with the scripted
// builder. No provider, VM, application runtime or hosted service participates in this test.
import { describe, expect, it } from "vitest";
import { loadOtfConfig } from "../../src/config.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { ruleSha256, sha256Hex, specSha256 } from "../../src/otf/canonical.ts";
import { otfCustomerDependencies } from "../../src/otf/compose.ts";
import { EXPECTED_CELLS, OTF_OPEN_CRITERION_ID, type OtfCreateJob, type OtfOpenRule, type OtfSpecCard } from "../../src/otf/contract.ts";
import { createCustomerHandlers } from "../../src/otf/handlers.ts";
import { parseOtf, validateOtf, type OtfBodies, type OtfSchemaName } from "../../src/otf/schemas.ts";
import { OtfTestWorld, syntheticDelivery } from "../../src/otf/test-mode/fake-builder.ts";
import { scenarioScript, TEST_LANES } from "../../src/otf/test-mode/timeline.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const VALIDATION = "00000000-0000-4000-8000-000000000003";
const PASSCODE = "synthetic-open-passcode";
const T0 = "2026-10-29T10:00:00.000Z";
const SPEC: OtfSpecCard = {
  title: "Synthetic stale task reads",
  where: "The task read response.",
  change: "A task read keeps the old title after a successful update.",
  why_tests_miss: "The original checks do not compare a read after this update.",
  checks_to_add: ["Read the task after an update and compare the saved title."],
  fix: "Read the latest saved title.",
};
const RULE: OtfOpenRule = {
  family: "state_ui",
  observable_failure: "POST /api/tasks creates a task; PATCH /api/tasks/{id} changes its title, but GET /api/tasks/{id} returns the original title after the update succeeds.",
  failure_code: "synthetic_stale_task_read",
};
function request(path: string, body?: unknown): Request {
  return new Request(`https://synthetic.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: factorySessionCookie(PASSCODE), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function parsed<N extends OtfSchemaName>(schema: N, response: Response): Promise<OtfBodies[N]> {
  const result = parseOtf(schema, await response.json());
  if (!result.ok) throw new Error(`${schema}: ${result.errors.join("; ")}`);
  return result.value;
}

describe("open behavior synthetic test mode", () => {
  it("issues an open-1 certificate bound to the submitted rule", async () => {
    const delivery = syntheticDelivery({
      job_id: JOB, criterion_id: OTF_OPEN_CRITERION_ID, rule: RULE,
      spec_sha256: await specSha256(SPEC), builder_id: "00000000-0000-4000-8000-000000000004",
      claimed_at_ms: Date.parse(T0), speed: 1, script: scenarioScript("delivered"),
    });
    expect(delivery.certificate.rule).toEqual(RULE);
    expect(delivery.certificate.criterion).toEqual({ criterion_id: OTF_OPEN_CRITERION_ID, version: "open-1", failure_code: RULE.failure_code });
    expect(validateOtf("OtfCertificate", delivery.certificate)).toEqual([]);
    expect(validateOtf("ResultPost", delivery.post)).toEqual([]);
  });

  it("creates, claims, delivers, downloads and validates the open job through the customer handlers", async () => {
    let now = Date.parse(T0);
    const world = new OtfTestWorld({ scenario: "delivered", clock: () => now, speed: 60 });
    const otf = loadOtfConfig({
      DATABASE_URL: "postgres://synthetic.invalid/otf",
      RBW_OTF_BUILDER_SECRET: "synthetic-open-builder-secret-placeholder",
      RBW_OTF_LANES: JSON.stringify(TEST_LANES.map(({ model, model_label, price_in_usd_per_m, price_out_usd_per_m }) => ({ model, model_label, price_in_usd_per_m, price_out_usd_per_m }))),
    });
    const deps = otfCustomerDependencies({ otf, passcode: PASSCODE, store: world.store, power: world.power, now: () => world.now(), openBehaviors: true });
    let ids = 0;
    const handlers = createCustomerHandlers({ ...deps, id: () => ids++ === 0 ? JOB : VALIDATION });
    // The only replacement is the configured fake power port; the production lifecycle starts it.
    deps.config.enabled = true;
    const input: OtfCreateJob = {
      client_key: CLIENT, host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID,
      sentence: "A task read keeps the old title after an update.", spec: SPEC,
      spec_sha256: await specSha256(SPEC), rule: RULE, rule_sha256: await ruleSha256(RULE),
    };
    const create = await handlers.create(request("/api/factory/otf/jobs", input));
    expect(create.status).toBe(201);
    const created = await parsed("OtfCreateResponse", create);
    expect(created.status).toMatchObject({ job_id: JOB, state: "starting_builder", rule: RULE });
    expect(world.fakes.power.calls.filter((call) => call === "start")).toHaveLength(1);
    const repeated = await handlers.create(request("/api/factory/otf/jobs", input));
    expect(repeated.status).toBe(200);
    expect((await parsed("OtfCreateResponse", repeated)).job_id).toBe(JOB);

    now += 2_000;
    let status = await parsed("OtfJobStatus", await handlers.status(request(`/api/factory/otf/jobs/${JOB}`), JOB));
    expect(status.state).toBe("building");
    expect(status.events.some((event) => event.type === "job_claimed")).toBe(true);
    expect(await world.store.getJob(JOB)).toMatchObject({ rule: RULE, state: "building" });
    expect(status.artifacts).toEqual([]);
    const earlyValidation = await handlers.validate(request(`/api/factory/otf/jobs/${JOB}/validations`, {}), JOB);
    expect((await parsed("OtfErrorBody", earlyValidation)).error.code).toBe("not_delivered");

    now += 20_000;
    status = await parsed("OtfJobStatus", await handlers.status(request(`/api/factory/otf/jobs/${JOB}`), JOB));
    expect(status).toMatchObject({ state: "finished", outcome: "delivered", rule: RULE,
      certificate: { rule: RULE, criterion: { version: "open-1", failure_code: RULE.failure_code }, received: { sha256_verified: true } } });
    expect(status.events.some((event) => event.type === "winner_selected")).toBe(true);
    expect(status.events.some((event) => event.type === "packaging")).toBe(true);
    expect(status.artifacts).toHaveLength(3);
    for (const artifact of status.artifacts) {
      const response = await handlers.artifact(request(artifact.download_path), JOB, artifact.part);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(artifact.size);
      expect(await sha256Hex(bytes)).toBe(artifact.sha256);
      if (artifact.part === "certificate") {
        const certificate: unknown = JSON.parse(new TextDecoder().decode(bytes));
        expect(validateOtf("OtfCertificate", certificate)).toEqual([]);
        expect(certificate).toMatchObject({ rule: RULE, criterion: { version: "open-1" } });
      }
    }

    const validation = await handlers.validate(request(`/api/factory/otf/jobs/${JOB}/validations`, {}), JOB);
    expect(validation.status).toBe(201);
    expect(await parsed("OtfValidation", validation)).toMatchObject({ validation_id: VALIDATION, state: "queued" });
    // A read lets the fake builder claim validation; its three-minute script takes three seconds.
    status = await parsed("OtfJobStatus", await handlers.status(request(`/api/factory/otf/jobs/${JOB}`), JOB));
    expect(status.validation?.state).toBe("running");
    now += 3_000;
    status = await parsed("OtfJobStatus", await handlers.status(request(`/api/factory/otf/jobs/${JOB}`), JOB));
    expect(status.validation).toMatchObject({ validation_id: VALIDATION, state: "passed", cells: EXPECTED_CELLS, admission: null });
    expect(status.artifacts).toHaveLength(3);
    expect(status.rule).toEqual(RULE);
  });
});
