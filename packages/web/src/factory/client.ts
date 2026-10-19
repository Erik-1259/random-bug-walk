/** UI projection of bug-request/1 draft revision 1, pinned at 7540362198f5940f1add45a65593ac314e8d751e.
 * Replace these transport projections with the contract owner's shared exports when published.
 * This adapter does not interpret, qualify, schedule, or reserve spend. */
export const FACTORY_CONTRACT_REVISION = "7540362198f5940f1add45a65593ac314e8d751e";
export interface RequestInput {
  hosts: string[];
  items: { item_key: string; bug_type_id: string; quantity: number; description: string | null; difficulty: string }[];
  budget_microusd: number;
}
export interface Capabilities {
  contract_version: string;
  service: { state: string; code: string | null; message: string | null };
  hosts: { host_id: string; label: string; description: string; baseline_id: string }[];
  bug_types: { bug_type_id: string; label: string; description: string; criteria: { criterion_id: string; version: string; label: string; description: string; example_phrases: string[] }[] }[];
  combinations: { host_id: string; bug_type_id: string; status: string; reason: string | null; source: { entries: number; description: string } | null }[];
  difficulty_options: { option_id: string; label: string; default: boolean; available: boolean; reason: string | null }[];
  limits: { max_items: number; max_quantity_per_item: number; max_total_quantity: number; max_description_chars: number; budget_presets_microusd: number[]; default_budget_microusd: number; min_budget_microusd: number; max_budget_microusd: number; max_wall_clock_s: number; max_candidates: number };
}
export interface Problem { code: string; severity: string; message: string; item_key: string | null }
export interface Interpretation {
  contract_version: string; interpretation_sha256: string; input: RequestInput; startable: boolean;
  items: { item_key: string; bug_type_id: string; quantity: number; description: string | null; status: string;
    criteria: { criterion_id: string; version: string; label: string; matched_text: string | null }[];
    unmatched_text: string[]; problems: Problem[] }[];
  type_totals: { bug_type_id: string; quantity: number }[];
  hosts: { host_id: string; used: boolean; reason: string | null }[];
  budget: { budget_microusd: number; worker_worst_case_microusd: number; estimate_note: string; worst_case_per_validation_microusd: { host_id: string; microusd: number }[] };
  problems: Problem[];
}
export interface Cell { expected: string; observed: string; runs_valid: number; runs_total: number; matches_expectation: boolean }
export interface ValidationRun {
  contract_version: string; validation_id: string; case_id: string; state: string; result: string | null;
  matrix: { original_suite: { clean: Cell; buggy: Cell; fixed: Cell }; verification: { clean: Cell; buggy: Cell; fixed: Cell } } | null;
  message: string | null; cost_microusd: number | null; poll_after_ms: number;
}
export interface PackagePart { kind: string; filename: string; ready: boolean; download_path: string | null; sha256: string }
export interface FactoryCase {
  case_id: string; title: string; host_id: string; host_label: string; baseline_id: string; bug_type_id: string; item_key: string | null;
  summary: { observed_failure: string; how_checked: string };
  difficulty: { status: string; note: string };
  packages: { bug_case: PackagePart; validator: PackagePart };
  validation: ValidationRun | null;
}
export interface FactoryEvent { seq: number; at: string; type: string; message: string }
export interface RequestStatus {
  contract_version: string; request_id: string; state: string; outcome: string | null; delivery: string;
  stop_reason: { code: string; message: string } | null; attention: { code: string; message: string } | null;
  interpretation: Interpretation;
  budget: { budget_microusd: number; reserved_microusd: number; spent_microusd: number; committed_microusd: number; remaining_microusd: number; overrun: boolean };
  funnel: { candidates_explored: number; behavior_checks_passed: number; requested_criteria_passed: number; packages_ready: number };
  items: { item_key: string; bug_type_id: string; description: string | null; requested: number; delivered: number; missing: number; case_ids: string[] }[];
  type_totals: { bug_type_id: string; requested: number; delivered: number; missing: number }[];
  candidates: { candidate_id: string; host_id: string; stage: string; reason: { code: string; message: string } | null }[];
  cases: FactoryCase[]; events: FactoryEvent[]; next_after: number; poll_after_ms: number;
}
export interface StartRequest { request_id: string; input: RequestInput; interpretation_sha256: string }
export class FactoryError extends Error {
  code: string; status: number; details: Record<string, unknown> | null;
  constructor(code: string, message: string, status = 0, details: Record<string, unknown> | null = null) { super(message); this.code = code; this.status = status; this.details = details; }
}
export interface FactoryClient {
  capabilities(): Promise<Capabilities>;
  session(): Promise<{ signed_in: boolean }>;
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
      if (!record(data) || data.contract_version !== "bug-request/1") throw new FactoryError("unavailable", "The request service is unavailable or uses an unsupported contract.", response.status);
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
const VALIDATION_KEY = "rbw-factory-validation";
interface StoredValidation { request_id: string; case_id: string; validation_id: string }
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
  private failures = 0;
  private generation = 0;
  private moreEvents = false;
  private refreshAfterValidation = false;
  constructor(client: FactoryClient, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, uuid: () => string, now: () => number = Date.now) { this.client = client; this.storage = storage; this.uuid = uuid; this.now = now; }
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
    this.validationIdentity = record(savedValidation) && savedValidation.request_id === id && typeof savedValidation.case_id === "string" && typeof savedValidation.validation_id === "string" ? savedValidation as unknown as StoredValidation : null;
    return id;
  }
  async initialize() {
    if (this.view.busy) return;
    this.update({ busy: true });
    const mayResume = !this.initialized || this.now() >= this.nextPollAt;
    this.initialized = true;
    try {
      const id = this.restoreIdentity();
      const [capabilities, session] = await Promise.allSettled([this.client.capabilities(), this.client.session()]);
      if (capabilities.status === "fulfilled") this.update({ capabilities: capabilities.value }); else this.error(capabilities.reason);
      if (session.status === "fulfilled") this.update({ signedIn: session.value.signed_in }); else this.error(session.reason);
      if (id !== null && this.view.signedIn && mayResume) await this.readStatus();
      if (this.validationIdentity !== null && this.view.signedIn && mayResume) await this.readValidation();
    } catch (error) { this.error(error); } finally { this.update({ busy: false }); }
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
    this.update({ busy: true });
    try {
      // Another tab may have started since this tab initialized. Resume its identity before writing.
      if (this.restoreIdentity() !== null) {
        await this.readStatus();
        if (this.validationIdentity !== null) await this.readValidation();
        return;
      }
      const interpretation = this.view.interpretation;
      const id = this.uuid();
      this.startBody = { request_id: id, input: interpretation.input, interpretation_sha256: interpretation.interpretation_sha256 };
      // Both writes precede the POST. If storage fails there is no execution.
      this.storage.setItem(START_KEY, JSON.stringify(this.startBody));
      this.storage.setItem(REQUEST_KEY, id);
      this.update({ requestId: id });
      await this.sendStart();
    } catch (error) { this.error(error); } finally { this.update({ busy: false }); }
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
    this.update({ busy: true, canRetryStart: false });
    try { await this.sendStart(); } finally { this.update({ busy: false }); }
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
      this.storage.removeItem(REQUEST_KEY); this.storage.removeItem(START_KEY); this.storage.removeItem(VALIDATION_KEY);
    }
    this.startBody = null; this.validationIdentity = null; this.moreEvents = false; this.refreshAfterValidation = false;
    this.update({ requestId: null, status: null, validation: null, canRetryStart: false, canRetryValidation: false });
  }
  newDraft() {
    if (this.view.busy || this.view.status?.state !== "finished" || this.view.status.attention !== null || this.view.status.cases.some(item => item.validation !== null && item.validation.state !== "finished") || (this.validationIdentity !== null && this.view.validation?.state !== "finished")) return;
    try { this.clearIdentity(); this.invalidateInterpretation(); } catch (error) { this.error(error); }
  }
  async stop() {
    if (this.view.busy || !this.view.signedIn || this.view.requestId === null || this.view.status === null || this.view.status.state === "finished") return;
    this.update({ busy: true });
    try { this.accept(await this.client.stop(this.view.requestId)); }
    catch (error) { this.error(error); await this.readStatus(); } finally { this.update({ busy: false }); }
  }
  async validate(caseId: string) {
    const status = this.view.status;
    const found = status?.cases.find(item => item.case_id === caseId);
    if (this.view.busy || !this.view.signedIn || status?.state !== "finished" || status.attention !== null || !found?.packages.bug_case.ready || !found.packages.validator.ready || (this.validationIdentity !== null && this.view.validation?.state !== "finished")) return;
    const worstCase = status.interpretation.budget.worst_case_per_validation_microusd.find(entry => entry.host_id === found.host_id)?.microusd;
    if (worstCase === undefined || status.budget.remaining_microusd < worstCase || status.cases.some(item => item.validation !== null && item.validation.state !== "finished")) return;
    this.update({ busy: true });
    try {
      const identity = { request_id: status.request_id, case_id: caseId, validation_id: this.uuid() };
      this.storage.setItem(VALIDATION_KEY, JSON.stringify(identity));
      this.validationIdentity = identity;
      this.update({ validation: null, canRetryValidation: false });
      await this.sendValidation();
    } catch (error) { this.error(error); } finally { this.update({ busy: false }); }
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
      if (["budget_unavailable", "not_ready", "invalid_request", "not_found"].includes(failure.code)) {
        // A definite refusal recorded no validation. Keep the delivered request and refusal message.
        this.storage.removeItem(VALIDATION_KEY);
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
    this.update({ busy: true });
    try { await this.sendValidation(); } finally { this.update({ busy: false }); }
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
