import { canonicalJson, specSha256 } from "./canonical.ts";
import { OTF_CREATE_REFUSALS, OTF_ERROR_STATUS, POLL_FINISHED_MS, POLL_RUNNING_MS, type OtfAvailability, type OtfCreateJob, type OtfCreateResponse, type OtfErrorCode, type OtfJobStatus, type OtfValidation } from "./contract.ts";
import { isOtf, type OtfBodies, type OtfSchemaName } from "./schemas.ts";

export interface OtfClient {
  availability(): Promise<OtfAvailability>;
  create(body: OtfCreateJob): Promise<OtfCreateResponse>;
  status(jobId: string, after?: number): Promise<OtfJobStatus>;
  stop(jobId: string): Promise<OtfJobStatus>;
  validate(jobId: string): Promise<OtfValidation>;
}
export class OtfClientError extends Error {
  readonly code: OtfErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: OtfErrorCode, message: string, status = 0, retryable = false) {
    super(message); this.code = code; this.status = status; this.retryable = retryable;
  }
}
function unavailable(): OtfClientError { return new OtfClientError("unavailable", "The custom build service did not return a usable response. Saved job identity is retained.", 0, true); }
function jobMatches(status: OtfJobStatus, jobId: string, request?: OtfCreateJob): void {
  if (status.job_id !== jobId || (status.certificate !== null && status.certificate.job_id !== jobId)
    || status.artifacts.some(artifact => artifact.download_path !== `/api/factory/otf/jobs/${jobId}/artifacts/${artifact.part}`)) throw unavailable();
  if (request !== undefined && (status.criterion_id !== request.criterion_id || status.spec_sha256 !== request.spec_sha256
    || canonicalJson(status.spec) !== canonicalJson(request.spec) || status.catalog_request_id !== (request.catalog_request_id ?? null))) throw unavailable();
}
async function checkRequest(body: OtfCreateJob): Promise<void> {
  if (!isOtf("OtfCreateJob", body) || await specSha256(body.spec) !== body.spec_sha256) throw new OtfClientError("invalid_spec", "The accepted spec is invalid. Review the card before creating a job.");
}
/** Customer routes only. A malformed envelope never becomes a successful job or a definite refusal. */
export function createOtfClient(fetcher: typeof fetch = fetch, timeoutMs = 15_000): OtfClient {
  async function call<N extends OtfSchemaName>(schema: N, path: string, method: "GET" | "POST", success: readonly number[], body?: OtfCreateJob): Promise<OtfBodies[N]> {
    const abort = new AbortController();
    const timeout = setTimeout(() => { abort.abort(); }, timeoutMs);
    try {
      const response = await fetcher(`/api/factory/otf/${path}`, { method, credentials: "same-origin", cache: "no-store", signal: abort.signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const data: unknown = await response.json();
      if (!response.ok) {
        if (!isOtf("OtfErrorBody", data) || OTF_ERROR_STATUS[data.error.code] !== response.status
          || (path === "jobs" && !(OTF_CREATE_REFUSALS as readonly string[]).includes(data.error.code))) throw unavailable();
        throw new OtfClientError(data.error.code, data.error.message, response.status, data.error.retryable);
      }
      if (!success.includes(response.status) || !isOtf(schema, data)) throw unavailable();
      return data;
    } catch (error) {
      if (error instanceof OtfClientError) throw error;
      throw unavailable();
    } finally { clearTimeout(timeout); }
  }
  const path = (id: string) => `jobs/${encodeURIComponent(id)}`;
  return {
    availability: () => call("OtfAvailability", "availability", "GET", [200]),
    create: async body => {
      await checkRequest(body);
      const response = await call("OtfCreateResponse", "jobs", "POST", [200, 201], body);
      jobMatches(response.status, response.job_id, body);
      return response;
    },
    status: async (id, after = 0) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new OtfClientError("invalid_request", "The event cursor is invalid.");
      const response = await call("OtfJobStatus", `${path(id)}?after=${String(after)}`, "GET", [200]);
      jobMatches(response, id); return response;
    },
    stop: async id => { const response = await call("OtfJobStatus", `${path(id)}/stop`, "POST", [202]); jobMatches(response, id); return response; },
    validate: id => call("OtfValidation", `${path(id)}/validations`, "POST", [200, 201]),
  };
}
export const otfClient = createOtfClient();
export const OTF_JOB_KEY = "rbw.otf.job";
export type OtfIdentityLock = (operation: () => Promise<void>) => Promise<void>;
export const browserOtfIdentityLock: OtfIdentityLock = async operation => {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Partial<Navigator>).locks;
  if (locks === undefined) throw new OtfClientError("unavailable", "This browser cannot safely coordinate custom build tabs. Web Locks support is required.");
  await locks.request("rbw.otf.job.lock", { mode: "exclusive" }, operation);
};
interface StoredJob {
  request: OtfCreateJob;
  job_id: string | null;
  /** Local association only: never inserted into the immutable create request on retry. */
  catalog_request_id: string | null;
  /** Present while a validation POST's outcome is unresolved; null means there was no prior run. */
  validation_before?: string | null;
  /** Only a definite refusal with no earlier ambiguous POST permits discarding this identity. */
  create_refused?: true;
}
export interface OtfView {
  availability: OtfAvailability | null;
  status: OtfJobStatus | null;
  busy: boolean;
  message: string | null;
  canRetryCreate: boolean;
  canNewDraft: boolean;
  jobId: string | null;
  /** The original accepted create body, retained even after a server job ID is known. */
  pendingRequest: OtfCreateJob | null;
  catalogRequestId: string | null;
  polling: boolean;
  validationPending: boolean;
}
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type CreateInput = Omit<OtfCreateJob, "client_key" | "spec_sha256">;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function validationOpen(validation: OtfValidation | null): boolean { return validation?.state === "queued" || validation?.state === "running"; }

/** External store for the browser. Only an explicit create/validation action can begin new work. */
export class OtfController {
  private view: OtfView = { availability: null, status: null, busy: false, message: null, canRetryCreate: false, canNewDraft: false, jobId: null, pendingRequest: null, catalogRequestId: null, polling: false, validationPending: false };
  private listeners = new Set<() => void>();
  private client: OtfClient;
  private storage: StoragePort;
  private uuid: () => string;
  private identityLock: OtfIdentityLock;
  private saved: StoredJob | null = null;
  private nextPollAt = 0;
  private failures = 0;
  private activePoll: Promise<void> | null = null;
  private activeAction: Promise<void> | null = null;
  private stopping = false;
  constructor(client: OtfClient, storage: StoragePort, uuid: () => string, identityLock: OtfIdentityLock = browserOtfIdentityLock) {
    this.client = client; this.storage = storage; this.uuid = uuid; this.identityLock = identityLock;
  }
  snapshot = (): OtfView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<OtfView>): void {
    const view = { ...this.view, ...change };
    view.canNewDraft = this.saved?.create_refused === true || (view.status?.state === "finished" && !view.validationPending && !validationOpen(view.status.validation));
    this.view = view; for (const listener of this.listeners) listener();
  }
  private failure(error: unknown): void {
    const failure = error instanceof OtfClientError ? error : unavailable();
    const minimum = this.view.status?.state === "finished" ? POLL_FINISHED_MS : POLL_RUNNING_MS;
    this.nextPollAt = Date.now() + Math.max(minimum, [15000, 30000, 60000][Math.min(this.failures++, 2)] ?? 60000);
    this.update({ message: `${failure.code}: ${failure.message}`, canRetryCreate: this.saved !== null && this.saved.job_id === null });
  }
  private save(value: StoredJob): void { this.storage.setItem(OTF_JOB_KEY, JSON.stringify(value)); this.saved = value; }
  private async restore(): Promise<boolean> {
    const raw = this.storage.getItem(OTF_JOB_KEY);
    let value: StoredJob | null = null;
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!record(parsed) || !isOtf("OtfCreateJob", parsed.request) || !(parsed.job_id === null || uuid(parsed.job_id))
        || !(parsed.catalog_request_id === null || uuid(parsed.catalog_request_id))
        || !(parsed.validation_before === undefined || parsed.validation_before === null || uuid(parsed.validation_before))
        || !(parsed.create_refused === undefined || (parsed.create_refused === true && parsed.job_id === null))) throw unavailable();
      await checkRequest(parsed.request);
      value = { request: parsed.request, job_id: parsed.job_id, catalog_request_id: parsed.catalog_request_id,
        ...(parsed.validation_before === undefined ? {} : { validation_before: parsed.validation_before }),
        ...(parsed.create_refused === true ? { create_refused: true } : {}) };
    }
    const changed = value?.request.client_key !== this.saved?.request.client_key || value?.job_id !== this.saved?.job_id;
    this.saved = value;
    this.update({ jobId: value?.job_id ?? null, pendingRequest: value?.request ?? null,
      catalogRequestId: value?.catalog_request_id ?? value?.request.catalog_request_id ?? null,
      validationPending: value?.validation_before !== undefined, canRetryCreate: value !== null && value.job_id === null,
      ...(changed ? { status: null } : {}) });
    return changed;
  }
  private action(operation: () => Promise<void>): Promise<void> {
    if (this.view.busy) return Promise.resolve();
    this.update({ busy: true });
    const pending = Promise.resolve().then(() => this.identityLock(operation))
      .catch((error: unknown) => { this.failure(error); })
      .finally(() => { this.activeAction = null; this.update({ busy: false }); });
    this.activeAction = pending;
    return pending;
  }
  private accept(status: OtfJobStatus, after: number): void {
    const saved = this.saved;
    if (saved?.job_id === null || saved === null || !isOtf("OtfJobStatus", status)) throw unavailable();
    jobMatches(status, saved.job_id, saved.request);
    const prior = this.view.status;
    if (prior !== null && (status.created_at !== prior.created_at || (prior.state === "finished" && status.state !== "finished"))) throw unavailable();
    let cursor = after;
    const events = new Map((prior?.events ?? []).map(event => [event.seq, event]));
    for (const event of status.events) {
      if (event.seq !== ++cursor) throw unavailable();
      const old = events.get(event.seq);
      if (old !== undefined && canonicalJson(old) !== canonicalJson(event)) throw unavailable();
      events.set(event.seq, event);
    }
    if (status.next_after !== cursor || cursor < (prior?.next_after ?? 0)) throw unavailable();
    if (saved.validation_before !== undefined && status.validation !== null && status.validation.validation_id !== saved.validation_before) {
      const cleared = { ...saved }; delete cleared.validation_before; this.save(cleared);
    }
    this.failures = 0;
    this.nextPollAt = Date.now() + Math.max(status.state === "finished" ? POLL_FINISHED_MS : POLL_RUNNING_MS, status.poll_after_ms);
    this.update({ status: { ...status, events: [...events.values()].sort((a, b) => a.seq - b.seq) }, jobId: saved.job_id,
      pendingRequest: saved.request, catalogRequestId: saved.catalog_request_id ?? status.catalog_request_id,
      validationPending: this.saved?.validation_before !== undefined, message: null, canRetryCreate: false });
  }
  private async readStatus(): Promise<void> {
    const id = this.saved?.job_id;
    if (id === null || id === undefined) return;
    const after = this.view.status?.next_after ?? 0;
    this.accept(await this.client.status(id, after), after);
  }
  private async sendCreate(firstAttempt = false): Promise<void> {
    let saved = this.saved;
    if (saved?.job_id !== null) return;
    const mayDiscardRefusal = firstAttempt || saved.create_refused === true;
    if (saved.create_refused === true) {
      saved = { ...saved }; delete saved.create_refused; this.save(saved);
    }
    let result: OtfCreateResponse;
    try { result = await this.client.create(structuredClone(saved.request)); }
    catch (error) {
      if (mayDiscardRefusal && error instanceof OtfClientError && OTF_ERROR_STATUS[error.code] === error.status
        && ["busy", "daily_cap", "spend_cap", "refused_topic", "invalid_spec", "signed_out"].includes(error.code)) this.save({ ...saved, create_refused: true });
      throw error;
    }
    if (!isOtf("OtfCreateResponse", result)) throw unavailable();
    jobMatches(result.status, result.job_id, saved.request);
    this.save({ ...saved, job_id: result.job_id });
    this.update({ jobId: result.job_id });
    this.accept(result.status, 0);
  }
  async initialize(): Promise<void> {
    if (this.view.busy) return;
    // Availability remains useful even when the browser cannot access saved job storage.
    try { const value = await this.client.availability(); if (!isOtf("OtfAvailability", value)) throw unavailable(); this.update({ availability: value }); }
    catch (error) { this.failure(error); }
    await this.action(async () => { await this.restore(); if (this.saved?.job_id === null) await this.sendCreate(); else await this.readStatus(); });
  }
  async create(input: CreateInput): Promise<void> {
    // Clone before hashing or waiting for a lock; later edits cannot change an accepted card.
    const accepted = structuredClone(input);
    await this.action(async () => {
      await this.restore();
      if (this.saved !== null) { if (this.saved.job_id === null) await this.sendCreate(); else await this.readStatus(); return; }
      if (this.view.availability?.enabled !== true) throw new OtfClientError("unavailable", "Custom builds are offline right now. The catalog is available.");
      const body = { ...accepted, client_key: this.uuid(), spec_sha256: await specSha256(accepted.spec) };
      await checkRequest(body);
      this.save({ request: body, job_id: null, catalog_request_id: body.catalog_request_id ?? null });
      this.update({ pendingRequest: body, catalogRequestId: body.catalog_request_id ?? null });
      await this.sendCreate(true);
    });
  }
  async retryCreate(): Promise<void> { await this.action(async () => { await this.restore(); if (this.saved?.job_id === null) await this.sendCreate(); else await this.readStatus(); }); }
  needsPoll(): boolean { return this.view.jobId !== null; }
  pollAfter(): number { return Math.max(1000, this.nextPollAt - Date.now()); }
  async poll(): Promise<void> {
    if (this.view.busy || this.stopping || !this.needsPoll() || Date.now() < this.nextPollAt) return;
    this.update({ polling: true });
    const pending = this.action(async () => { await this.restore(); await this.readStatus(); });
    this.activePoll = pending;
    try { await pending; } finally { this.activePoll = null; this.update({ polling: false }); }
  }
  async stop(): Promise<void> {
    if (this.stopping || (this.view.busy && this.activePoll === null)) return;
    this.stopping = true;
    try {
      if (this.activePoll !== null) await this.activePoll;
      await this.action(async () => {
        const changed = await this.restore(); if (changed) await this.readStatus();
        const id = this.saved?.job_id;
        if (id === null || id === undefined || this.view.status === null || this.view.status.state === "finished") return;
        this.accept(await this.client.stop(id), 0);
      });
    } finally { this.stopping = false; }
  }
  async validate(): Promise<void> {
    const seenValidation = this.view.status?.validation?.validation_id ?? null;
    await this.action(async () => {
      const changed = await this.restore(); if (changed) { await this.readStatus(); return; }
      if (this.view.status?.state !== "finished" || this.view.status.outcome !== "delivered") return;
      // Another tab may have validated since this view was rendered. Observe it before another POST.
      await this.readStatus();
      const saved = this.saved; const status = this.view.status;
      if (saved?.job_id === null || saved === null || status.outcome !== "delivered" || status.state !== "finished"
        || saved.validation_before !== undefined || validationOpen(status.validation)
        || (status.validation?.validation_id ?? null) !== seenValidation) return;
      this.save({ ...saved, validation_before: status.validation?.validation_id ?? null });
      this.update({ validationPending: true });
      let result: OtfValidation;
      try { result = await this.client.validate(saved.job_id); }
      catch (error) {
        if (error instanceof OtfClientError && OTF_ERROR_STATUS[error.code] === error.status
          && ["signed_out", "invalid_request", "not_found", "not_delivered"].includes(error.code)) {
          this.save(saved); this.update({ validationPending: false });
        }
        throw error;
      }
      if (!isOtf("OtfValidation", result)) throw unavailable();
      this.save(saved);
      this.nextPollAt = Date.now() + POLL_FINISHED_MS;
      this.update({ status: { ...status, validation: result }, validationPending: false, message: null });
    });
  }
  async setCatalogRequestId(id: string): Promise<void> {
    if (this.activeAction !== null) await this.activeAction;
    await this.action(async () => {
      await this.restore(); if (!uuid(id)) throw new OtfClientError("invalid_request", "The catalog request identity is invalid.");
      if (this.saved === null) return;
      this.save({ ...this.saved, catalog_request_id: id }); this.update({ catalogRequestId: id });
    });
  }
  async newDraft(): Promise<void> {
    await this.action(async () => {
      const changed = await this.restore(); if (changed) { await this.readStatus(); return; }
      if (this.view.status?.state === "finished") await this.readStatus();
      if (!this.view.canNewDraft) return;
      this.storage.removeItem(OTF_JOB_KEY); this.saved = null;
      this.update({ status: null, jobId: null, pendingRequest: null, catalogRequestId: null, validationPending: false, canRetryCreate: false, message: null });
    });
  }
}
