import type {
  CreateJobResult,
  JobPatch,
  NebiusInstanceState,
  OtfArtifactRecord,
  OtfBuilderInfo,
  OtfEvent,
  OtfJobRecord,
  OtfJobState,
  OtfNewJob,
  OtfPart,
  OtfPowerLogEntry,
  OtfPowerRecord,
  OtfStore,
  OtfValidationRecord,
  OtfValidationState,
  ProductionEvent,
  VmPower,
} from "../../src/otf/contract.ts";

export const FAKE_AT = "2026-01-01T00:00:00.000Z";

/** Customer-route fixture only. No database, provider or builder implementation is exercised. */
export class FakeOtfStore implements OtfStore {
  readonly jobs = new Map<string, OtfJobRecord>();
  readonly events = new Map<string, OtfEvent[]>();
  readonly artifacts = new Map<string, OtfArtifactRecord & { bytes: Uint8Array }>();
  readonly validations = new Map<string, OtfValidationRecord>();
  readonly powerLog: OtfPowerLogEntry[] = [];
  builderSeen: (OtfBuilderInfo & { last_seen_at: string }) | null = null;
  power: OtfPowerRecord = {
    state: "stopped", since: FAKE_AT, preset: "synthetic-preset", instance_state: "STOPPED",
    last_api_call_at: null, last_start_at: null, last_stop_at: null, start_failures: 0,
    running_since: null, last_job_finished_at: null, vm_seconds_today: 0,
    vm_day: "2026-01-01", hold_until: null,
  };
  private readonly seenBoots = new Set<string>();
  private powerTail: Promise<void> = Promise.resolve();

  createJob(input: OtfNewJob): Promise<CreateJobResult> {
    const existing = [...this.jobs.values()].find((job) => job.client_key === input.client_key);
    if (existing) {
      return Promise.resolve(existing.create_sha256 === input.create_sha256
        ? { kind: "replayed", job: structuredClone(existing) }
        : { kind: "conflict" });
    }
    if (this.jobs.has(input.job_id)) return Promise.reject(new Error("Duplicate synthetic job ID"));
    const job: OtfJobRecord = {
      ...structuredClone(input), outcome: null, reason: null, claimed_by: null, claimed_at: null,
      lease_until: null, deadline_at: null, last_builder_post_at: null, stop_requested_at: null,
      stop_reason: null, winner_lane: null, winner_model: null, model_microusd: 0,
      certificate: null, finished_at: null,
    };
    this.jobs.set(job.job_id, job);
    return Promise.resolve({ kind: "created", job: structuredClone(job) });
  }

  getJob(job_id: string): Promise<OtfJobRecord | null> {
    return Promise.resolve(structuredClone(this.jobs.get(job_id) ?? null));
  }

  listJobs(states: readonly OtfJobState[]): Promise<OtfJobRecord[]> {
    return Promise.resolve(structuredClone([...this.jobs.values()]
      .filter((job) => states.includes(job.state))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))));
  }

  countJobsCreatedSince(at: string): Promise<number> {
    return Promise.resolve([...this.jobs.values()].filter((job) => Date.parse(job.created_at) >= Date.parse(at)).length);
  }

  totalModelMicrousd(): Promise<number> {
    return Promise.resolve([...this.jobs.values()].reduce((sum, job) => sum + job.model_microusd, 0));
  }

  updateJob(job_id: string, whenStates: readonly OtfJobState[], patch: JobPatch): Promise<OtfJobRecord | null> {
    const job = this.jobs.get(job_id);
    if (!job || !whenStates.includes(job.state)) return Promise.resolve(null);
    const updated = { ...job, ...structuredClone(patch) };
    this.jobs.set(job_id, updated);
    return Promise.resolve(structuredClone(updated));
  }

  appendJobEvent(job_id: string, event: ProductionEvent, at: string): Promise<OtfEvent> {
    if (!this.jobs.has(job_id)) return Promise.reject(new Error("Synthetic job does not exist"));
    const events = this.events.get(job_id) ?? [];
    const stored: OtfEvent = { ...structuredClone(event), seq: (events.at(-1)?.seq ?? 0) + 1, at };
    events.push(stored);
    this.events.set(job_id, events);
    return Promise.resolve(structuredClone(stored));
  }

  listEvents(job_id: string, after: number): Promise<OtfEvent[]> {
    return Promise.resolve(structuredClone((this.events.get(job_id) ?? [])
      .filter((event) => event.seq > after).sort((a, b) => a.seq - b.seq)));
  }

  recordBuilderSeen(info: OtfBuilderInfo, at: string): Promise<{ first_of_boot: boolean }> {
    const key = `${info.builder_id}:${info.boot_id}`;
    const first_of_boot = !this.seenBoots.has(key);
    this.seenBoots.add(key);
    if (this.builderSeen === null || Date.parse(at) >= Date.parse(this.builderSeen.last_seen_at)) {
      this.builderSeen = { ...structuredClone(info), last_seen_at: at };
    }
    return Promise.resolve({ first_of_boot });
  }

  lastBuilderSeen(): Promise<(OtfBuilderInfo & { last_seen_at: string }) | null> {
    return Promise.resolve(structuredClone(this.builderSeen));
  }

  appendBuilderEvents: OtfStore["appendBuilderEvents"] = () => Promise.reject(new Error("Builder event ingestion is outside the customer-route fake"));
  claimNext: OtfStore["claimNext"] = () => Promise.reject(new Error("Builder claims are outside the customer-route fake"));
  storeDelivery: OtfStore["storeDelivery"] = () => Promise.reject(new Error("Builder delivery is outside the customer-route fake"));

  listArtifacts(job_id: string): Promise<OtfArtifactRecord[]> {
    return Promise.resolve([...this.artifacts.values()].filter((part) => part.job_id === job_id).map((part) => ({
      job_id: part.job_id, part: part.part, filename: part.filename, media_type: part.media_type,
      size: part.size, sha256: part.sha256,
    })));
  }

  getArtifact(job_id: string, part: OtfPart): Promise<(OtfArtifactRecord & { bytes: Uint8Array }) | null> {
    return Promise.resolve(structuredClone(this.artifacts.get(`${job_id}:${part}`) ?? null));
  }

  createValidation(job_id: string, validation_id: string, at: string): Promise<OtfValidationRecord> {
    if (this.validations.has(validation_id)) return Promise.reject(new Error("Duplicate synthetic validation ID"));
    const validation: OtfValidationRecord = {
      validation_id, job_id, state: "queued", cells: null, admission: null, started_at: at, finished_at: null, claimed_by: null,
    };
    this.validations.set(validation_id, validation);
    return Promise.resolve(structuredClone(validation));
  }

  getValidation(validation_id: string): Promise<OtfValidationRecord | null> {
    return Promise.resolve(structuredClone(this.validations.get(validation_id) ?? null));
  }

  latestValidation(job_id: string): Promise<OtfValidationRecord | null> {
    const records = [...this.validations.values()].filter((validation) => validation.job_id === job_id);
    records.reverse().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    return Promise.resolve(structuredClone(records[0] ?? null));
  }

  updateValidation(
    validation_id: string,
    whenStates: readonly OtfValidationState[],
    patch: Partial<Pick<OtfValidationRecord, "state" | "cells" | "admission" | "finished_at">>,
  ): Promise<OtfValidationRecord | null> {
    const validation = this.validations.get(validation_id);
    if (!validation || !whenStates.includes(validation.state)) return Promise.resolve(null);
    const updated = { ...validation, ...structuredClone(patch) };
    this.validations.set(validation_id, updated);
    return Promise.resolve(structuredClone(updated));
  }

  getPower(): Promise<OtfPowerRecord> { return Promise.resolve(structuredClone(this.power)); }

  async withPowerLock<T>(fn: (power: OtfPowerRecord) => Promise<{
    patch: Partial<OtfPowerRecord> | null; log: OtfPowerLogEntry[]; result: T;
  }>): Promise<T> {
    const previous = this.powerTail;
    let release: () => void = () => { throw new Error("Synthetic power lock was not initialized"); };
    this.powerTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const response = await fn(structuredClone(this.power));
      if (response.patch !== null) this.power = { ...this.power, ...structuredClone(response.patch) };
      this.powerLog.push(...structuredClone(response.log));
      return response.result;
    } finally { release(); }
  }
}

export class FakeVmPower implements VmPower {
  state: NebiusInstanceState = "STOPPED";
  preset = "synthetic-preset";
  getCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  startError: Error | null = null;

  get(): Promise<{ state: NebiusInstanceState; preset: string }> {
    this.getCalls += 1;
    return Promise.resolve({ state: this.state, preset: this.preset });
  }

  start(): Promise<{ operation_id: string }> {
    this.startCalls += 1;
    if (this.startError) return Promise.reject(this.startError);
    if (this.state !== "RUNNING") this.state = "STARTING";
    return Promise.resolve({ operation_id: "synthetic-start-operation" });
  }

  stop(): Promise<{ operation_id: string }> {
    this.stopCalls += 1;
    if (this.state !== "STOPPED") this.state = "STOPPING";
    return Promise.resolve({ operation_id: "synthetic-stop-operation" });
  }
}
