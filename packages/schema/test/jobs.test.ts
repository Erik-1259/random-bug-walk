import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CodeState, ExpectedCheck, ExpectedTrials, JobKind, JobRequest, MutationChange, MutationIdentity, OperationIdentity, TaskRevisionIdentity } from "../src/generated.ts";
import {
  buildExpectedTrials,
  buildJobRequest,
  callName,
  jobOperationIdentity,
  jobPayloadHash,
  mutationId,
  operationId,
  providerCallIdentity,
  taskRevision,
  type ExpectedTrialsInput,
  type JobRequestFields,
} from "../src/jobs.ts";
import { RecordError, validateRecord } from "../src/validate.ts";
import { fixtureBytes, fixtureText, readManifest } from "./support.ts";

const record = (name: string): unknown => JSON.parse(fixtureText("records", `${name}.json`));
const committedSha = (name: string): string => fixtureText("records", `${name}.sha256`);
const sameBytes = (bytes: Uint8Array, name: string): boolean => Buffer.from(bytes).equals(fixtureBytes("records", `${name}.canonical`));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function refusal(action: () => unknown): readonly string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof RecordError) return error.errors;
    throw error;
  }
  throw new Error("expected a refusal");
}

// The check vectors of the first fixture; the fixture package owns them, so they are test inputs here.
const CHECK_IDS = ["tzarg.utc-day-counts", "tzarg.la-day-counts", "tzarg.auckland-day-counts", "tzarg.kolkata-day-counts"];
const pass = (checkId: string): ExpectedCheck => ({ check_id: checkId, expected: "pass", failure_code: null });
const fail = (checkId: string, code: ExpectedCheck["failure_code"]): ExpectedCheck => ({ check_id: checkId, expected: "assertion_fail", failure_code: code });
const [UTC = "", LA = "", AKL = "", KOL = ""] = CHECK_IDS;
const VECTORS: Record<CodeState, ExpectedCheck[]> = {
  clean: CHECK_IDS.map(pass),
  fixed: CHECK_IDS.map(pass),
  planted: [pass(UTC), fail(LA, "local_day_counts_mismatch"), fail(AKL, "local_day_counts_mismatch"), fail(KOL, "local_day_counts_mismatch")],
  partial: [pass(UTC), fail(LA, "local_day_counts_mismatch"), pass(AKL), fail(KOL, "local_day_counts_mismatch")],
  stub: [pass(UTC), fail(LA, "bucket_labels_mismatch"), fail(AKL, "bucket_labels_mismatch"), fail(KOL, "bucket_labels_mismatch")],
};
const PATCHES = { fixed: "c".repeat(64), planted: "d".repeat(64), partial: "7".repeat(64), stub: "3".repeat(64) };
const ORIGINAL_SUITE = "1".repeat(64);
const TEST_IDS = ["0000000000000000aaaa-00000000000000000001", "0000000000000000aaaa-00000000000000000002"];
const ADDED_SUITE = "2".repeat(64);

const KINDS: [JobKind, string, number][] = [
  ["kit_check", "kit-check", 5],
  ["observe", "observe", 1],
  ["admission", "admission", 13],
  ["judge_verify", "judge-verify", 3],
];

function trialsInput(kind: JobKind, fixture: string): ExpectedTrialsInput {
  const committed = (record(`expected-trials-${fixture}`) as ExpectedTrials);
  return {
    kind,
    executionId: committed.execution_id,
    taskRevision: committed.task_revision,
    patchSha256: PATCHES,
    originalSuiteSha256: ORIGINAL_SUITE,
    originalTestIds: TEST_IDS,
    addedSuiteSha256: ADDED_SUITE,
    checks: VECTORS,
  };
}

function withoutIds(request: JobRequest): JobRequestFields {
  const fields: Partial<JobRequest> = { ...request };
  delete fields.operation_id;
  delete fields.payload_hash;
  return fields as JobRequestFields;
}

describe("buildExpectedTrials", () => {
  it.each(KINDS)("reproduces the committed %s manifest", (kind, fixture, count) => {
    const built = buildExpectedTrials(trialsInput(kind, fixture));
    expect(built.manifest.trials).toHaveLength(count);
    expect(sameBytes(built.bytes, `expected-trials-${fixture}`)).toBe(true);
    expect(built.sha256).toBe(committedSha(`expected-trials-${fixture}`));
    expect(built.sha256).toBe((record(`job-request-${fixture}`) as JobRequest).expected_trials_sha256);
  });

  it("lists the admission trials in the fixed order", () => {
    const built = buildExpectedTrials(trialsInput("admission", "admission"));
    expect(built.manifest.trials.map((trial) => `${trial.trial_id}:${trial.code_state}:${String(trial.added_repeat_count)}`)).toEqual([
      "clean-01:clean:1",
      "fixed-01:fixed:20",
      "fixed-02:fixed:1",
      "fixed-03:fixed:1",
      "fixed-04:fixed:1",
      "fixed-05:fixed:1",
      "planted-01:planted:20",
      "planted-02:planted:1",
      "planted-03:planted:1",
      "planted-04:planted:1",
      "planted-05:planted:1",
      "partial-01:partial:1",
      "stub-01:stub:1",
    ]);
  });

  it("ignores the original-suite inputs for observe", () => {
    const built = buildExpectedTrials(trialsInput("observe", "observe"));
    expect(built.manifest.trials[0]?.original_suite_sha256).toBeNull();
    expect(built.manifest.trials[0]?.original_test_ids).toEqual([]);
    const withoutSuite = buildExpectedTrials({ ...trialsInput("observe", "observe"), originalSuiteSha256: null, originalTestIds: [] });
    expect(withoutSuite.sha256).toBe(built.sha256);
  });

  it("needs no patch hash for kit_check", () => {
    expect(buildExpectedTrials({ ...trialsInput("kit_check", "kit-check"), patchSha256: {} }).sha256).toBe(committedSha("expected-trials-kit-check"));
  });

  it("refuses a missing patch hash for a code state the kind uses", () => {
    const withoutStub: Partial<typeof PATCHES> = { ...PATCHES };
    delete withoutStub.stub;
    expect(refusal(() => buildExpectedTrials({ ...trialsInput("admission", "admission"), patchSha256: withoutStub }))).toEqual(["build:patch_missing"]);
    expect(refusal(() => buildExpectedTrials({ ...trialsInput("observe", "observe"), patchSha256: {} }))).toEqual(["build:patch_missing"]);
  });

  it("refuses a missing check vector", () => {
    const withoutPartial: Partial<typeof VECTORS> = { ...VECTORS };
    delete withoutPartial.partial;
    expect(refusal(() => buildExpectedTrials({ ...trialsInput("admission", "admission"), checks: withoutPartial }))).toEqual(["build:checks_missing"]);
  });

  it("refuses a kind that is not a job kind", () => {
    const input = { ...trialsInput("admission", "admission"), kind: "factory" } as unknown as ExpectedTrialsInput;
    expect(refusal(() => buildExpectedTrials(input))).toEqual(["build:kind"]);
  });

  it("refuses a non-observe manifest without an original suite", () => {
    expect(refusal(() => buildExpectedTrials({ ...trialsInput("admission", "admission"), originalSuiteSha256: null, originalTestIds: [] }))).toEqual(["build:original_suite_missing"]);
  });

  it("refuses an invalid result", () => {
    const errors = refusal(() => buildExpectedTrials({ ...trialsInput("admission", "admission"), addedSuiteSha256: "Z" }));
    expect(errors.every((error) => error.startsWith("schema:"))).toBe(true);
  });
});

describe("buildJobRequest", () => {
  it.each(["kit-check", "observe", "observe-root", "admission", "judge-verify"])("reproduces job-request-%s", (fixture) => {
    const committed = (record(`job-request-${fixture}`) as JobRequest);
    const built = buildJobRequest(withoutIds(committed));
    expect(built.request).toEqual(committed);
    expect(sameBytes(built.bytes, `job-request-${fixture}`)).toBe(true);
    expect(built.sha256).toBe(committedSha(`job-request-${fixture}`));
  });

  it.each(["batch_id", "project_id", "kind", "attempt_ordinal"])("refuses fields without %s with a schema error", (key) => {
    const fields = Object.fromEntries(Object.entries(withoutIds(record("job-request-admission") as JobRequest)).filter(([name]) => name !== key));
    const errors = refusal(() => buildJobRequest(fields as unknown as JobRequestFields));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.startsWith("schema:"))).toBe(true);
  });

  it("refuses fields that break a request rule", () => {
    const fields = withoutIds((record("job-request-observe") as JobRequest));
    expect(refusal(() => buildJobRequest({ ...fields, baseline_evidence_key: null, baseline_evidence_sha256: null })).length).toBeGreaterThan(0);
    expect(refusal(() => buildJobRequest({ ...fields, parent_execution_id: null }))).toEqual(["job:root_parent"]);
  });
});

describe("operationId", () => {
  const job = (record("operation-identity-job") as OperationIdentity);
  const alternatives: { [K in keyof OperationIdentity]?: OperationIdentity[K] } = {
    project_id: "00000000-0000-4000-8000-000000000002",
    project_policy_sha256: "0".repeat(64),
    root_execution_id: "00000000-0000-4000-8000-000000000102",
    batch_id: "00000000-0000-4000-8000-000000000302",
    task_revision: "0".repeat(64),
    kind: "observe",
    runtime_profile_sha256: "0".repeat(64),
    call_name: "admission:cand-17:1",
    attempt_ordinal: 2,
  };

  it("is the committed hash of the identity record, and stable", () => {
    expect(operationId(job).sha256).toBe(committedSha("operation-identity-job"));
    expect(sameBytes(operationId(job).bytes, "operation-identity-job")).toBe(true);
    expect(operationId(structuredClone(job)).sha256).toBe(operationId(job).sha256);
    expect(operationId(record("operation-identity-call") as OperationIdentity).sha256).toBe(committedSha("operation-identity-call"));
  });

  it.each(Object.entries(alternatives))("changes when %s changes", (key, value) => {
    expect(operationId({ ...job, [key]: value }).sha256).not.toBe(operationId(job).sha256);
  });

  it("is the job request's own operation_id for a job", () => {
    expect(operationId(jobOperationIdentity((record("job-request-admission") as JobRequest))).sha256).toBe(committedSha("operation-identity-job"));
  });

  it("changes with the runtime profile while the task revision stays the same", () => {
    const fields = withoutIds((record("job-request-admission") as JobRequest));
    const first = buildJobRequest(fields).request;
    const second = buildJobRequest({ ...fields, runtime_profile_sha256: "0".repeat(64) }).request;
    expect(second.operation_id).not.toBe(first.operation_id);
    expect(second.task_revision).toBe(first.task_revision);
    const revision = (record("task-revision-complete") as TaskRevisionIdentity);
    expect(taskRevision(revision).sha256).toBe(first.task_revision);
    expect(refusal(() => taskRevision({ ...revision, runtime_profile_sha256: "0".repeat(64) } as TaskRevisionIdentity)).length).toBeGreaterThan(0);
  });

  it("refuses an invalid identity", () => {
    expect(refusal(() => operationId({ ...job, call_name: "Writer.Issue" })).length).toBeGreaterThan(0);
  });
});

interface CallNameCase {
  name: string;
  kind: string;
  segments: (string | number)[];
  expect?: string;
  error?: string;
}

const CALL_NAME_CASES = (JSON.parse(fixtureText("call-names.json")) as { cases: CallNameCase[] }).cases;

describe("callName", () => {
  it.each(CALL_NAME_CASES.filter((item) => item.expect !== undefined).map((item) => [item.name, item] as const))("builds %s", (_name, item) => {
    const name = callName(item.kind, ...item.segments);
    expect(name).toBe(item.expect);
    expect(validateRecord("CallName", name)).toEqual([]);
  });

  it.each(CALL_NAME_CASES.filter((item) => item.error !== undefined).map((item) => [item.name, item] as const))("refuses %s", (_name, item) => {
    expect(refusal(() => callName(item.kind, ...item.segments))).toEqual([item.error]);
  });

  it("builds the committed provider-call name", () => {
    expect(callName("writer.issue", "cand-17", 3)).toBe(JSON.parse(fixtureText("records", "call-name-valid.json")));
  });

  it("refuses an ordinal that is not a safe non-negative integer", () => {
    for (const ordinal of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(refusal(() => callName("writer.issue", "cand-17", ordinal))).toEqual(["call_name:segment"]);
    }
  });
});

describe("providerCallIdentity", () => {
  const call = record("operation-identity-call") as OperationIdentity;
  const fields = {
    project_id: call.project_id,
    project_policy_sha256: call.project_policy_sha256,
    root_execution_id: call.root_execution_id,
    batch_id: call.batch_id,
    task_revision: call.task_revision,
    kind: call.kind,
    runtime_profile_sha256: call.runtime_profile_sha256,
    call_name: callName("writer.issue", "cand-17", 3),
    attempt_ordinal: call.attempt_ordinal,
  };

  it("is the committed provider-call identity, with schema version 1", () => {
    expect(providerCallIdentity(fields)).toEqual(call);
    expect(operationId(providerCallIdentity(fields)).sha256).toBe(committedSha("operation-identity-call"));
  });

  it("keeps only the identity fields of a wider run context", () => {
    const wider = { ...fields, execution_id: "00000000-0000-4000-8000-000000000102", parent_execution_id: null };
    expect(providerCallIdentity(wider)).toEqual(call);
  });

  it("refuses an invalid field", () => {
    expect(refusal(() => providerCallIdentity({ ...fields, call_name: "writer.issue::3" })).length).toBeGreaterThan(0);
    expect(refusal(() => providerCallIdentity({ ...fields, attempt_ordinal: 0 })).length).toBeGreaterThan(0);
  });
});

describe("jobPayloadHash", () => {
  const request = (record("job-request-judge-verify") as JobRequest);

  it("hashes the request without its payload_hash field", () => {
    const rest: Partial<JobRequest> = { ...request };
    delete rest.payload_hash;
    const digest = jobPayloadHash(request);
    expect(digest.sha256).toBe(request.payload_hash);
    expect(jobPayloadHash(rest as Omit<JobRequest, "payload_hash">).sha256).toBe(request.payload_hash);
    expect(jobPayloadHash({ ...request, payload_hash: "0".repeat(64) }).sha256).toBe(request.payload_hash);
    expect(new TextDecoder().decode(digest.bytes)).not.toContain("payload_hash");
    expect(new TextDecoder().decode(digest.bytes)).toContain(`"operation_id":"${request.operation_id}"`);
  });

  it.each(Object.keys(request).filter((key) => key !== "payload_hash"))("changes when %s changes", (key) => {
    const changed = { ...request, [key]: key === "attempt_ordinal" || key === "reservation_microusd" || key === "schema_version" ? 7 : `${String(request[key as keyof JobRequest])}-x` };
    expect(jobPayloadHash(changed).sha256).not.toBe(request.payload_hash);
  });
});

describe("mutationId", () => {
  const committed = (record("mutation-identity-valid") as MutationIdentity);
  const allowedPaths = committed.changes.map((change) => change.path);
  const [addition, deletion, modification] = committed.changes as [MutationChange, MutationChange, MutationChange];

  it("is the committed hash of the identity record", () => {
    const digest = mutationId({ host_commit: committed.host_commit, changes: committed.changes }, { allowedPaths });
    expect(digest.sha256).toBe(committedSha("mutation-identity-valid"));
    expect(sameBytes(digest.bytes, "mutation-identity-valid")).toBe(true);
  });

  it("gives the same ID for the changes in any order", () => {
    const orders = [
      [addition, deletion, modification],
      [modification, deletion, addition],
      [deletion, modification, addition],
      [modification, addition, deletion],
    ];
    for (const changes of orders) {
      expect(mutationId({ host_commit: committed.host_commit, changes }, { allowedPaths }).sha256).toBe(committedSha("mutation-identity-valid"));
    }
  });

  it("gives a different ID for a whitespace-only content change", () => {
    const one = { ...modification, resulting_sha256: sha256("const a = 1;\n") };
    const other = { ...modification, resulting_sha256: sha256("const a =  1;\n") };
    expect(mutationId({ host_commit: committed.host_commit, changes: [one] }, { allowedPaths }).sha256).not.toBe(
      mutationId({ host_commit: committed.host_commit, changes: [other] }, { allowedPaths }).sha256,
    );
  });

  it("changes when the host commit or any change field changes", () => {
    const base = mutationId({ host_commit: committed.host_commit, changes: [modification] }, { allowedPaths }).sha256;
    const variants: MutationChange[] = [
      { ...modification, path: addition.path },
      { ...modification, original_sha256: "0".repeat(64) },
      { ...modification, resulting_sha256: "0".repeat(64) },
      { ...modification, original_mode: "100755" },
      { ...modification, resulting_mode: "100755" },
    ];
    for (const change of variants) {
      expect(mutationId({ host_commit: committed.host_commit, changes: [change] }, { allowedPaths }).sha256).not.toBe(base);
    }
    expect(mutationId({ host_commit: "0".repeat(40), changes: [modification] }, { allowedPaths }).sha256).not.toBe(base);
  });

  it.each([
    ["a symlink mode", { ...addition, resulting_mode: "120000" }, "mutation:mode"],
    ["a submodule mode", { ...deletion, original_mode: "160000" }, "mutation:mode"],
    ["a .. segment", { ...addition, path: "src/../etc/passwd" }, "mutation:traversal"],
    ["a . segment", { ...addition, path: "src/./lib/date-buckets.ts" }, "mutation:traversal"],
    ["an absolute path", { ...addition, path: "/src/lib/date-buckets.ts" }, "mutation:absolute_path"],
    ["a path outside the allowed set", { ...addition, path: "src/lib/other.ts" }, "mutation:outside_allowed"],
  ])("refuses %s before hashing", (_label, change, code) => {
    const allowed = [...allowedPaths, change.path];
    const paths = code === "mutation:outside_allowed" ? allowedPaths : allowed;
    expect(refusal(() => mutationId({ host_commit: committed.host_commit, changes: [change as MutationChange] }, { allowedPaths: paths }))).toEqual([code]);
  });

  it("refuses a change that changes nothing, and an empty change list", () => {
    expect(refusal(() => mutationId({ host_commit: committed.host_commit, changes: [{ ...modification, resulting_sha256: modification.original_sha256 }] }, { allowedPaths }))).toEqual(["mutation:unchanged"]);
    expect(refusal(() => mutationId({ host_commit: committed.host_commit, changes: [] }, { allowedPaths })).length).toBeGreaterThan(0);
    expect(refusal(() => mutationId({ host_commit: committed.host_commit, changes: [addition, addition] }, { allowedPaths }))).toEqual(["mutation:changes_sorted"]);
  });
});

describe("taskRevision", () => {
  const complete = (record("task-revision-complete") as TaskRevisionIdentity);

  it.each(["kit", "provisional", "complete"])("is the committed hash of the %s revision", (kind) => {
    const digest = taskRevision(record(`task-revision-${kind}`) as TaskRevisionIdentity);
    expect(digest.sha256).toBe(committedSha(`task-revision-${kind}`));
    expect(sameBytes(digest.bytes, `task-revision-${kind}`)).toBe(true);
  });

  it("differs between the provisional and complete revisions of one candidate", () => {
    const provisional = (record("task-revision-provisional") as TaskRevisionIdentity);
    expect(provisional.mutation_id).toBe(complete.mutation_id);
    expect(taskRevision(provisional).sha256).not.toBe(taskRevision(complete).sha256);
  });

  it.each(Object.keys(complete).filter((key) => !["schema_version", "revision_kind"].includes(key)))("changes when %s changes", (key) => {
    const value = complete[key as keyof TaskRevisionIdentity];
    const changed = typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? "0".repeat(64) : key === "host_commit" ? "0".repeat(40) : key === "image_digest" ? `sha256:${"0".repeat(64)}` : "synthetic-other";
    expect(taskRevision({ ...complete, [key]: changed }).sha256).not.toBe(taskRevision(complete).sha256);
  });
});

describe("ID vectors", () => {
  const manifest = readManifest();
  const valid = (type: string): string[] => manifest.records.filter((item) => item.type === type && item.expect === "valid").map((item) => item.name);

  it.each(valid("JobRequest"))("recomputes operation_id and payload_hash of %s", (name) => {
    const request = (record(name) as JobRequest);
    expect(operationId(jobOperationIdentity(request)).sha256).toBe(request.operation_id);
    expect(jobPayloadHash(request).sha256).toBe(request.payload_hash);
    expect(validateRecord("JobRequest", request)).toEqual([]);
  });

  it("covers every identity kind", () => {
    expect(valid("JobRequest").length).toBeGreaterThanOrEqual(5);
    expect(valid("OperationIdentity")).toEqual(["operation-identity-job", "operation-identity-call"]);
    expect(valid("MutationIdentity")).toContain("mutation-identity-valid");
    expect(valid("TaskRevisionIdentity")).toEqual(["task-revision-kit", "task-revision-provisional", "task-revision-complete"]);
  });

  it("uses the complete revision for admission and the provisional one for observe", () => {
    expect((record("job-request-admission") as JobRequest).task_revision).toBe(committedSha("task-revision-complete"));
    expect((record("job-request-observe") as JobRequest).task_revision).toBe(committedSha("task-revision-provisional"));
    expect((record("job-request-kit-check") as JobRequest).task_revision).toBe(committedSha("task-revision-kit"));
    expect((record("task-revision-complete") as TaskRevisionIdentity).mutation_id).toBe(committedSha("mutation-identity-valid"));
  });
});
