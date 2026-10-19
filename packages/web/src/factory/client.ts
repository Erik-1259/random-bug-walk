/** Client integration with bug-request/1 draft revision 2 at the pinned shared-package commit.
 * Qualification, interpretation and execution remain service responsibilities. */
import { CONTRACT_VERSION_VALUES } from "@rbw/factory-contract";
import type { Capabilities, RequestInput, Interpretation, RequestStatus, StartRequest, ValidationRun, SessionStatus } from "@rbw/factory-contract";
export type { Capabilities, RequestInput, Interpretation, RequestStatus, StartRequest, ValidationRun, Cell, PackagePart, Problem, Case as FactoryCase, Event as FactoryEvent } from "@rbw/factory-contract";
export const FACTORY_CONTRACT_REVISION = "52a7dc9a50a56c07539d100c4eb2f0f95039b0cb";
export class FactoryError extends Error {
  code: string; status: number; details: Record<string, unknown> | null;
  constructor(code: string, message: string, status = 0, details: Record<string, unknown> | null = null) { super(message); this.code = code; this.status = status; this.details = details; }
}
export interface FactoryClient {
  capabilities(): Promise<Capabilities>;
  session(): Promise<SessionStatus>;
  signIn(passcode: string): Promise<void>;
  interpret(input: RequestInput): Promise<Interpretation>;
  start(input: StartRequest): Promise<RequestStatus>;
  status(id: string, after?: number): Promise<RequestStatus>;
  stop(id: string): Promise<RequestStatus>;
  validate(id: string, caseId: string, validationId: string): Promise<ValidationRun>;
  validation(id: string, caseId: string, validationId: string): Promise<ValidationRun>;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Missing/HTML endpoints and unknown envelopes are unavailable, never synthetic success. */
export function createFactoryClient(fetcher: typeof fetch = fetch): FactoryClient {
  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 15000);
    try {
      const response = await fetcher(`/api/factory/${path}`, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      if (response.status === 204 && path === "session" && method === "POST") return undefined as T;
      const data: unknown = await response.json();
      if (!record(data) || data.contract_version !== CONTRACT_VERSION_VALUES[0]) throw new FactoryError("unavailable", "The request service is unavailable or uses an unsupported contract.", response.status);
      if (!response.ok) {
        if (!record(data.error) || typeof data.error.code !== "string" || typeof data.error.message !== "string") throw new FactoryError("unavailable", "The request service returned an unreadable error.", response.status);
        throw new FactoryError(data.error.code, data.error.message, response.status, record(data.error.details) ? data.error.details : null);
      }
      return data as T;
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw new FactoryError("unavailable", "The request service did not respond. Existing request identity is retained.");
    } finally { clearTimeout(timeout); }
  }
  const requestPath = (id: string) => `requests/${encodeURIComponent(id)}`;
  const validationPath = (id: string, caseId: string) => `${requestPath(id)}/cases/${encodeURIComponent(caseId)}/validations`;
  return {
    capabilities: () => call("capabilities"), session: () => call("session"), signIn: (passcode) => call("session", "POST", { passcode }),
    interpret: (input) => call("interpretations", "POST", input), start: (input) => call("requests", "POST", input),
    status: (id, after = 0) => call(`${requestPath(id)}?after=${String(after)}`), stop: (id) => call(`${requestPath(id)}/stop`, "POST", {}),
    validate: (id, caseId, validationId) => call(validationPath(id, caseId), "POST", { validation_id: validationId }),
    validation: (id, caseId, validationId) => call(`${validationPath(id, caseId)}/${encodeURIComponent(validationId)}`),
  };
}
export const factoryClient = createFactoryClient();

export const REQUEST_KEY = "rbw-factory-request-id";
const START_KEY = "rbw-factory-start";
const VALIDATION_KEY = "rbw-factory-validation"; // Scoped metadata also preserves revision-1 browser sessions.
export const VALIDATION_ID_KEY = "rbw-factory-validation-id";
interface StoredValidation { request_id: string; case_id: string; validation_id: string }
export type FactoryIdentityLock = (operation: () => Promise<void>) => Promise<void>;
/** One origin-wide lock covers identity writes and the response that decides whether they can clear. */
export const browserIdentityLock: FactoryIdentityLock = async operation => {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Partial<Navigator>).locks;
  if (locks === undefined) throw new FactoryError("unavailable", "This browser cannot safely coordinate factory tabs. Web Locks support is required.");
  await locks.request("rbw-factory-identity", { mode: "exclusive" }, operation);
};
export interface FactoryView {
  capabilities: Capabilities | null; signedIn: boolean; interpretation: Interpretation | null;
  status: RequestStatus | null; validation: ValidationRun | null; requestId: string | null;
  busy: boolean; message: string | null; canRetryStart: boolean; canRetryValidation: boolean;
}
/** The browser owns identity, never execution. A failed read cannot create replacement work. */
export class FactoryController {
  private view: FactoryView = { capabilities: null, signedIn: false, interpretation: null, status: null, validation: null, requestId: null, busy: false, message: null, canRetryStart: false, canRetryValidation: false };
  private listeners = new Set<() => void>();
  private client: FactoryClient;
  private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private uuid: () => string;
  private startBody: StartRequest | null = null;
  private validationIdentity: StoredValidation | null = null;
  private pollDelay = 15000;
  private nextPollAt = 0;
  private initialized = false;
  private now: () => number;
  private identityLock: FactoryIdentityLock;
  private failures = 0;
  private generation = 0;
  private moreEvents = false;
  private refreshAfterValidation = false;
  constructor(client: FactoryClient, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, uuid: () => string, now: () => number = Date.now, identityLock: FactoryIdentityLock = browserIdentityLock) { this.client = client; this.storage = storage; this.uuid = uuid; this.now = now; this.identityLock = identityLock; }
  snapshot = (): FactoryView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<FactoryView>) { this.view = { ...this.view, ...change }; for (const listener of this.listeners) listener(); }
  private error(error: unknown) {
    const failure = error instanceof FactoryError ? error : new FactoryError("unavailable", "The operation could not complete. Existing request identity is retained.");
    this.pollDelay = [15000, 30000, 60000][Math.min(this.failures++, 2)] ?? 60000;
    this.nextPollAt = this.now() + this.pollDelay;
    this.update({ message: `${failure.code}: ${failure.message}`, ...(failure.code === "unauthorized" ? { signedIn: false } : {}) });
    return failure;
  }
  private accept(status: RequestStatus) {
    if (status.request_id !== this.view.requestId) throw new FactoryError("unavailable", "The response does not belong to the stored request.");
    const previous = this.view.status;
    const events = new Map((previous?.events ?? []).map(event => [event.seq, event]));
    for (const event of status.events) events.set(event.seq, event);
    this.pollDelay = Math.max(1000, status.poll_after_ms);
    this.nextPollAt = this.now() + this.pollDelay;
    this.moreEvents = status.events.length === 200;
    this.refreshAfterValidation = false;
    this.update({ status: { ...status, events: [...events.values()].sort((a, b) => a.seq - b.seq) }, interpretation: status.interpretation, message: null, canRetryStart: false });
  }
  private restoreIdentity() {
    const id = this.storage.getItem(REQUEST_KEY);
    if (id !== this.view.requestId) this.update({ requestId: id, status: null, validation: null, canRetryStart: false, canRetryValidation: false });
    const raw = this.storage.getItem(START_KEY);
    const saved: unknown = raw === null ? null : JSON.parse(raw);
    this.startBody = record(saved) && saved.request_id === id ? saved as unknown as StartRequest : null;
    const validation = this.storage.getItem(VALIDATION_KEY);
    const savedValidation: unknown = validation === null ? null : JSON.parse(validation);
    const identity = record(savedValidation) && savedValidation.request_id === id && typeof savedValidation.case_id === "string" && typeof savedValidation.validation_id === "string" ? savedValidation as unknown as StoredValidation : null;
    if (identity !== null) {
      const storedId = this.storage.getItem(VALIDATION_ID_KEY);
      if (storedId !== null && storedId !== identity.validation_id) throw new FactoryError("unavailable", "Saved validation identity is inconsistent; no replacement work was started.");
      if (storedId === null) this.storage.setItem(VALIDATION_ID_KEY, identity.validation_id);
    }
    if (identity?.validation_id !== this.validationIdentity?.validation_id) this.update({ validation: null, canRetryValidation: false });
    this.validationIdentity = identity;
    return id;
  }
  private async identityAction(operation: () => Promise<void>) {
    if (this.view.busy) return;
    this.update({ busy: true });
    try { await this.identityLock(operation); }
    catch (error) { this.error(error); } finally { this.update({ busy: false }); }
  }
  private async adoptOtherIdentity() {
    const requestId = this.view.requestId;
    const validationId = this.validationIdentity?.validation_id;
    this.restoreIdentity();
    const changed = requestId !== this.view.requestId || validationId !== this.validationIdentity?.validation_id;
    if (changed) {
      await this.readStatus();
      if (this.validationIdentity !== null) await this.readValidation();
    }
    return changed;
  }
  async initialize() {
    if (this.view.busy) return;
    this.update({ busy: true });
    const mayResume = !this.initialized || this.now() >= this.nextPollAt;
    this.initialized = true;
    try { await this.identityLock(async () => {
      const id = this.restoreIdentity();
      const [capabilities, session] = await Promise.allSettled([this.client.capabilities(), this.client.session()]);
      if (capabilities.status === "fulfilled") this.update({ capabilities: capabilities.value }); else this.error(capabilities.reason);
      if (session.status === "fulfilled") this.update({ signedIn: session.value.signed_in }); else this.error(session.reason);
      if (id !== null && this.view.signedIn && mayResume) await this.readStatus();
      if (this.validationIdentity !== null && this.view.signedIn && mayResume) await this.readValidation();
    }); } catch (error) { this.error(error); } finally { this.update({ busy: false }); }
  }
  invalidateInterpretation() { this.generation++; this.update({ interpretation: null }); }
  async interpret(input: RequestInput) {
    if (this.view.busy || this.view.requestId !== null || this.view.capabilities?.service.state !== "available") return;
    const generation = ++this.generation;
    this.update({ busy: true, interpretation: null, message: null });
    try { const interpretation = await this.client.interpret(input); if (generation === this.generation) this.update({ interpretation }); }
    catch (error) { this.error(error); } finally { this.update({ busy: false }); }
  }
  async signIn(passcode: string) {
    if (this.view.busy) return;
    this.update({ busy: true });
    try { await this.client.signIn(passcode); this.update({ signedIn: true, message: null }); if (this.view.requestId !== null) await this.readStatus(); if (this.validationIdentity !== null) await this.readValidation(); }
    catch (error) { this.error(error); } finally { this.update({ busy: false }); }
  }
  async start() {
    if (this.view.busy || !this.view.signedIn || this.view.capabilities?.service.state !== "available" || this.view.requestId !== null || !this.view.interpretation?.startable) return;
    await this.identityAction(async () => {
      // Another tab may have started since this tab initialized. Resume its identity before writing.
      if (this.restoreIdentity() !== null) {
        await this.readStatus();
        if (this.validationIdentity !== null) await this.readValidation();
        return;
      }
      const interpretation = this.view.interpretation;
      if (!interpretation?.startable) return;
      const id = this.uuid();
      this.startBody = { request_id: id, input: interpretation.input, interpretation_sha256: interpretation.interpretation_sha256 };
      // Both writes precede the POST. If storage fails there is no execution.
      this.storage.setItem(START_KEY, JSON.stringify(this.startBody));
      this.storage.setItem(REQUEST_KEY, id);
      this.update({ requestId: id });
      await this.sendStart();
    });
  }
  private async sendStart() {
    if (this.startBody === null) return;
    try { this.accept(await this.client.start(this.startBody)); }
    catch (error) {
      const failure = this.error(error);
      if (["budget_unavailable", "unsupported_request", "interpretation_stale", "invalid_request"].includes(failure.code)) {
        this.clearIdentity();
        this.update({ interpretation: null }); // Re-interpret explicitly, never silently accept a changed meaning.
      } else if (failure.code === "busy") {
        await this.readStatus(true);
      } else if (failure.status === 0 || failure.status >= 500) {
        await this.readStatus();
      }
    }
  }
  async retryStart() {
    if (this.view.busy || !this.view.canRetryStart || !this.view.signedIn || this.startBody === null) return;
    await this.identityAction(async () => {
      if (await this.adoptOtherIdentity()) return;
      this.update({ canRetryStart: false });
      await this.sendStart();
    });
  }
  private async readStatus(busyRefusal = false) {
    const id = this.view.requestId;
    if (id === null) return;
    try { this.accept(await this.client.status(id, this.view.status?.next_after ?? 0)); }
    catch (error) {
      const failure = error instanceof FactoryError ? error : new FactoryError("unavailable", "Status could not be read.");
      if (failure.code === "not_found" && busyRefusal) { this.clearIdentity(); return; }
      this.error(failure);
      if (failure.code === "not_found") this.update({ canRetryStart: this.startBody !== null, message: "Request not found yet. Its identity is retained; retrying sends the same request, never a replacement." });
    }
  }
  private clearIdentity() {
    if (this.storage.getItem(REQUEST_KEY) === this.view.requestId) {
      this.storage.removeItem(REQUEST_KEY); this.storage.removeItem(START_KEY); this.storage.removeItem(VALIDATION_KEY); this.storage.removeItem(VALIDATION_ID_KEY);
    }
    this.startBody = null; this.validationIdentity = null; this.moreEvents = false; this.refreshAfterValidation = false;
    this.update({ requestId: null, status: null, validation: null, canRetryStart: false, canRetryValidation: false });
  }
  async newDraft() {
    await this.identityAction(async () => {
      if (await this.adoptOtherIdentity()) return;
      if (this.view.status?.state !== "finished" || this.view.status.attention !== null || this.view.status.cases.some(item => item.validation !== null && item.validation.state !== "finished") || (this.validationIdentity !== null && this.view.validation?.state !== "finished")) return;
      this.clearIdentity(); this.invalidateInterpretation();
    });
  }
  async stop() {
    if (this.view.busy || !this.view.signedIn || this.view.requestId === null || this.view.status === null || this.view.status.state === "finished") return;
    this.update({ busy: true });
    try { this.accept(await this.client.stop(this.view.requestId)); }
    catch (error) { this.error(error); await this.readStatus(); } finally { this.update({ busy: false }); }
  }
  async validate(caseId: string) {
    if (!this.view.signedIn) return;
    await this.identityAction(async () => {
      if (await this.adoptOtherIdentity()) return;
      const status = this.view.status;
      const found = status?.cases.find(item => item.case_id === caseId);
      if (!this.view.signedIn || status?.state !== "finished" || status.attention !== null || !found?.packages.bug_case.ready || !found.packages.validator.ready || (this.validationIdentity !== null && this.view.validation?.state !== "finished")) return;
      const worstCase = status.interpretation.budget.worst_case_per_validation_microusd.find(entry => entry.host_id === found.host_id)?.microusd;
      if (worstCase === undefined || status.budget.remaining_microusd < worstCase || status.cases.some(item => item.validation !== null && item.validation.state !== "finished")) return;
      const identity = { request_id: status.request_id, case_id: caseId, validation_id: this.uuid() };
      this.storage.setItem(VALIDATION_KEY, JSON.stringify(identity));
      this.storage.setItem(VALIDATION_ID_KEY, identity.validation_id);
      this.validationIdentity = identity;
      this.update({ validation: null, canRetryValidation: false });
      await this.sendValidation();
    });
  }
  private async sendValidation() {
    const id = this.validationIdentity;
    if (id === null) return;
    try {
      const validation = await this.client.validate(id.request_id, id.case_id, id.validation_id);
      this.pollDelay = Math.max(this.pollDelay, validation.poll_after_ms);
      this.nextPollAt = this.now() + this.pollDelay;
      this.refreshAfterValidation = true;
      this.update({ validation, canRetryValidation: false, message: null });
    }
    catch (error) {
      const failure = this.error(error);
      if (["budget_unavailable", "invalid_request", "not_found"].includes(failure.code)) {
        // A definite refusal recorded no validation. Keep the delivered request and refusal message.
        this.storage.removeItem(VALIDATION_KEY); this.storage.removeItem(VALIDATION_ID_KEY);
        this.validationIdentity = null;
        this.update({ validation: null, canRetryValidation: false });
      } else if (failure.code === "busy" || failure.status === 0 || failure.status >= 500) {
        await this.readValidation();
      }
    }
  }
  private async readValidation() {
    const id = this.validationIdentity;
    if (id === null) return;
    try {
      const validation = await this.client.validation(id.request_id, id.case_id, id.validation_id);
      if (validation.validation_id !== id.validation_id || validation.case_id !== id.case_id) throw new FactoryError("unavailable", "Validation response does not match the saved run.");
      this.pollDelay = Math.max(this.pollDelay, validation.poll_after_ms);
      this.nextPollAt = this.now() + this.pollDelay;
      this.refreshAfterValidation = validation.state === "finished";
      this.update({ validation, canRetryValidation: false });
    } catch (error) { const failure = this.error(error); if (failure.code === "not_found") this.update({ canRetryValidation: true }); }
  }
  async retryValidation() {
    if (this.view.busy || !this.view.signedIn || !this.view.canRetryValidation) return;
    await this.identityAction(async () => {
      if (await this.adoptOtherIdentity()) return;
      await this.sendValidation();
    });
  }
  pollAfter(): number { return Math.max(1000, this.nextPollAt - this.now()); }
  needsPoll(): boolean { return this.view.signedIn && this.view.requestId !== null && (this.moreEvents || this.refreshAfterValidation || this.view.status?.state !== "finished" || this.view.status.attention !== null || this.view.status.cases.some(item => item.validation !== null && item.validation.state !== "finished") || (this.validationIdentity !== null && this.view.validation?.state !== "finished")); }
  async poll() {
    if (this.view.busy || !this.view.signedIn || this.now() < this.nextPollAt) return;
    this.update({ busy: true });
    const failures = this.failures;
    try { await this.readStatus(); if (this.validationIdentity !== null && this.view.validation?.state !== "finished") await this.readValidation(); if (this.failures === failures) this.failures = 0; }
    finally { this.update({ busy: false }); }
  }
}
