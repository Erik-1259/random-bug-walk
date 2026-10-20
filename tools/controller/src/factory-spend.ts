// The factory's ledger adapters: the request budgets and factory records ports (factory-ports.ts)
// over the spend ledger's budget functions and factory records (migrations 0006 and 0007), and the
// one database the web service and the worker open. Web-safe: pg only, no runner, driver or PGlite
// (factoryDatabaseOver takes any SqlClient, such as a PGlite instance in tests).
//
// The ports answer as the test fakes do: a read of something not recorded is null (or no events, no
// heartbeat, no stop), an append's replay, conflict and refusal are outcomes of their own, and
// every other refusal rejects with its code. Event reads page through the ledger's 1,000-event
// bound to the request's last seq, and keep each event's key, which the writers' keyed checks
// compare. A port write with an `at` records that time; every other write records `now`.
import pg from "pg";
import type { CaseEvidence } from "@rbw/factory";
import { canonicalDigest } from "@rbw/schema";
import { createFactoryRecords, createSpend, fromPg, withFactoryLock } from "@rbw/spend";
import type {
  AppendEvent,
  EventAppended,
  FactoryLockScope,
  KeyedEvent,
  Refusal,
  Result,
  Spend,
  FactoryRecords as SpendFactoryRecords,
  SqlClient,
  StoredValidation,
  ValidationEvent,
} from "@rbw/spend";
import { CONNECT_TIMEOUT_MS, databaseLedger } from "./database-ledger.ts";
import { WORKER_ACTOR } from "./factory-ledger.ts";
import type {
  AppendOutcome,
  BudgetResult,
  BudgetTotals,
  FactoryBudgets,
  FactoryLedger,
  FactoryLog,
  FactoryRecords,
  FactoryValidationRecord,
  StoredFactoryEvent,
  ValidationEventInput,
} from "./factory-ports.ts";

/** The most events one ledger read returns. */
const EVENT_PAGE = 1000;

function refused(what: string, refusal: Refusal): Error {
  return new Error(`${what} was refused (${refusal.code})`);
}

// Request budgets ---------------------------------------------------------------------------------

/**
 * The request budgets port over the ledger's budget functions. A close with a cause other than the
 * recorded one answers operation_conflict, as a conflicting operation does.
 */
function spendBudgets(spend: Spend): FactoryBudgets {
  return {
    reserve: (budgetKey, role, request) => spend.budgetReserve({ budget_key: budgetKey, role, reservation: request }),
    async close(budgetKey, cause) {
      const closed = await spend.closeBudget({ budget_key: budgetKey, cause, actor_role: WORKER_ACTOR });
      if (closed.ok) return { ok: true, replay: closed.replay };
      if (closed.code === "idempotency_conflict") return { ok: false, code: "operation_conflict", ...(closed.detail === undefined ? {} : { detail: closed.detail }) };
      return closed;
    },
    async status(budgetKey): Promise<BudgetResult<BudgetTotals>> {
      const status = await spend.budgetStatus({ budget_key: budgetKey });
      if (!status.ok) return status;
      return {
        ok: true,
        budget_microusd: status.cap_microusd,
        settled_microusd: status.settled_microusd,
        open_microusd: status.open_microusd,
        committed_microusd: status.committed_microusd,
        available_microusd: status.available_microusd,
        closed: status.closed === null ? null : { cause: status.closed.cause },
      };
    },
  };
}

// Factory records ---------------------------------------------------------------------------------

function storedEvent(event: KeyedEvent): StoredFactoryEvent {
  return { event_key: event.event_key, type: event.type, host_id: event.host_id, candidate_id: event.candidate_id, item_key: event.item_key, case_id: event.case_id, message: event.message, data: { ...event.data }, seq: event.seq, at: event.at };
}

const VALIDATION_EVENT_TYPES: ReadonlySet<string> = new Set<ValidationEventInput["type"]>(["running", "copy", "finished"]);

function isValidationEventType(type: string): type is ValidationEventInput["type"] {
  return VALIDATION_EVENT_TYPES.has(type);
}

function validationEvent(event: ValidationEvent): ValidationEventInput & { seq: number; at: string } {
  if (!isValidationEventType(event.type)) throw new Error(`a validation run's event has a type this code never appends (${event.type})`);
  return { seq: event.seq, at: event.at, event_key: event.event_key, type: event.type, data: event.data };
}

function validationRecord(run: StoredValidation): FactoryValidationRecord {
  return {
    validation_id: run.validation_id,
    request_id: run.request_id,
    case_id: run.case_id,
    host_id: run.host_id,
    root: run.root_execution_id,
    accepted_at: run.accepted_at,
    package_sha256: run.package_sha256,
    harness: run.harness,
    copies: run.copies,
  };
}

function appendOutcome(what: string, result: Result<EventAppended>): AppendOutcome {
  if (result.ok) return { kind: result.replay ? "replay" : "appended", seq: result.seq };
  if (result.code === "idempotency_conflict") return { kind: "conflict" };
  if (result.code === "event_not_allowed") return { kind: "refused", reason: result.code };
  throw refused(what, result);
}

/** A case's evidence as recorded: the canonical JSON text of the document. */
function evidenceText(evidence: CaseEvidence): string {
  return Buffer.from(canonicalDigest(evidence).bytes).toString("utf8");
}

function parsedEvidence(text: string): CaseEvidence {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("schema_version" in value) || value.schema_version !== 1 || !("case" in value) || !("record" in value)) {
    throw new Error("the recorded evidence is not a case's evidence document");
  }
  // Recorded only through recordEvidence, from a CaseEvidence.
  return value as CaseEvidence;
}

/** The factory records port over the ledger's factory records in `schema`. */
function recordsPort(source: { client: SqlClient; schema: string; now: () => Date }): FactoryRecords {
  const options = { client: source.client, schema: source.schema };
  const records = createFactoryRecords({ ...options, clock: source.now });
  /** The records whose writes record the caller's time. */
  const at = (time: Date): SpendFactoryRecords => createFactoryRecords({ ...options, clock: () => time });
  const readRequest = (requestId: string) => records.readRequest({ request_id: requestId, after: 0, limit: 1 });
  const readValidation = (validationId: string) => records.readValidation({ validation_id: validationId, after: 0, limit: 1 });

  return {
    async request(requestId) {
      const read = await readRequest(requestId);
      if (!read.ok) {
        if (read.code === "unknown_request") return null;
        throw refused("the request read", read);
      }
      const { request } = read;
      return {
        request_id: request.request_id,
        root: request.root_execution_id,
        budget_key: request.budget_key,
        interpretation: request.interpretation,
        interpretation_sha256: request.interpretation_sha256,
        profile_sha256: request.factory_profile_sha256,
        created_at: request.created_at,
      };
    },

    async appendEvent(requestId, event, time) {
      // Only the input's own fields: the ledger refuses any other key, such as a stored event's seq
      // and time. The port's event is the contract's (the store checks its type and fields); its
      // loose data type is narrowed here.
      const input = { request_id: requestId, event_key: event.event_key, type: event.type, host_id: event.host_id, candidate_id: event.candidate_id, item_key: event.item_key, case_id: event.case_id, message: event.message, data: event.data };
      return appendOutcome("the event append", await at(time).appendEvent(input as AppendEvent));
    },

    async events(requestId) {
      const events: StoredFactoryEvent[] = [];
      let after = 0;
      for (;;) {
        const page = await records.readRequestEvents({ request_id: requestId, after, limit: EVENT_PAGE });
        if (!page.ok) {
          if (page.code === "unknown_request") return [];
          throw refused("the request's event read", page);
        }
        events.push(...page.events.map(storedEvent));
        if (page.next_after >= page.last_seq) return events;
        if (page.events.length === 0) throw new Error("the request's events ended before its last seq");
        after = page.next_after;
      }
    },

    async recordHeartbeat(target, time) {
      let requestId: string;
      let validationId: string | null = null;
      if ("request_id" in target) {
        requestId = target.request_id;
      } else {
        const run = await readValidation(target.validation_id);
        if (!run.ok) throw refused("the validation run's read", run);
        requestId = run.validation.request_id;
        validationId = target.validation_id;
      }
      const recorded = await at(time).recordHeartbeat({ request_id: requestId, validation_id: validationId });
      if (!recorded.ok) throw refused("the heartbeat", recorded);
    },

    async lastHeartbeat(target) {
      let last: string | null;
      if ("request_id" in target) {
        const read = await readRequest(target.request_id);
        if (!read.ok) {
          if (read.code === "unknown_request") return null;
          throw refused("the request read", read);
        }
        last = read.last_heartbeat_at;
      } else {
        const read = await readValidation(target.validation_id);
        if (!read.ok) {
          if (read.code === "unknown_validation") return null;
          throw refused("the validation run's read", read);
        }
        last = read.validation.last_heartbeat_at;
      }
      return last === null ? null : new Date(last);
    },

    async stopRequested(requestId) {
      const read = await readRequest(requestId);
      if (!read.ok) {
        if (read.code === "unknown_request") return false;
        throw refused("the request read", read);
      }
      return read.stop !== null;
    },

    async recordValidation(record) {
      const recorded = await records.recordValidation({
        validation_id: record.validation_id,
        request_id: record.request_id,
        case_id: record.case_id,
        root_execution_id: record.root,
        host_id: record.host_id,
        accepted_at: record.accepted_at,
        package_sha256: { bug_case: record.package_sha256.bug_case, validator: record.package_sha256.validator },
        harness: { name: record.harness.name, version: record.harness.version },
        copies: record.copies,
      });
      if (recorded.ok) return recorded.replay ? "replay" : "created";
      if (recorded.code === "idempotency_conflict") return "conflict";
      throw refused("the validation run's record", recorded);
    },

    async validation(validationId) {
      const read = await readValidation(validationId);
      if (!read.ok) {
        if (read.code === "unknown_validation") return null;
        throw refused("the validation run's read", read);
      }
      return validationRecord(read.validation);
    },

    async appendValidationEvent(validationId, event, time) {
      const appended = await at(time).appendValidationEvent({ validation_id: validationId, event_key: event.event_key, type: event.type, data: event.data });
      return appendOutcome("the validation event append", appended);
    },

    async validationEvents(validationId) {
      const events: (ValidationEventInput & { seq: number; at: string })[] = [];
      let after = 0;
      for (;;) {
        const page = await records.readValidation({ validation_id: validationId, after, limit: EVENT_PAGE });
        if (!page.ok) {
          if (page.code === "unknown_validation") return [];
          throw refused("the validation run's read", page);
        }
        events.push(...page.events.map(validationEvent));
        if (page.next_after >= page.last_seq) return events;
        if (page.events.length === 0) throw new Error("the validation run's events ended before its last seq");
        after = page.next_after;
      }
    },

    async rootOwner(root) {
      const owner = await records.readRoot({ root_execution_id: root });
      if (owner.ok) return { request_id: owner.request_id, validation_id: owner.validation_id };
      if (owner.code.startsWith("unknown_")) return null;
      throw refused("the root read", owner);
    },

    async recordEvidence(input) {
      const recorded = await records.recordEvidence({ request_id: input.request_id, case_id: input.case_id, sha256: input.sha256, evidence_json: evidenceText(input.evidence) });
      if (recorded.ok) return recorded.replay ? "replay" : "recorded";
      throw refused("the evidence record", recorded);
    },

    async readEvidence(requestId, caseId) {
      const stored = await records.readEvidence({ request_id: requestId, case_id: caseId });
      if (stored.ok) return parsedEvidence(stored.evidence_json);
      if (stored.code === "unknown_evidence" || stored.code === "unknown_request") return null;
      throw refused("the evidence read", stored);
    },
  };
}

// The database ------------------------------------------------------------------------------------

/** The factory's ledger as the web service and the worker use it. */
export interface FactoryDatabase {
  /** The spend ledger's operations, settlement, slot and budget functions. */
  readonly spend: Spend;
  /** The ledger's own factory records, for what the ports do not cover (accepting a request, a stop, the status read). */
  readonly records: SpendFactoryRecords;
  /** The ports the launch, worker and lost-worker functions take. */
  readonly ledger: FactoryLedger;
  readonly factoryRecords: FactoryRecords;
  /**
   * Runs `fn` while no other start of the same scope and ID runs (contract sections 7 and 11);
   * other IDs and the other scope do not wait.
   */
  withStartLock<T>(scope: FactoryLockScope, id: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function ports(client: SqlClient, schema: string, now: () => Date): Pick<FactoryDatabase, "spend" | "records" | "ledger" | "factoryRecords"> {
  const spend = createSpend({ client, schema, clock: now });
  return { spend, records: createFactoryRecords({ client, schema, clock: now }), ledger: { spend, budgets: spendBudgets(spend) }, factoryRecords: recordsPort({ client, schema, now }) };
}

/** A lock per key within this process: each holder runs after every earlier holder of its key settled. */
function keyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const done = Promise.withResolvers<undefined>();
    const tail = previous.then(() => done.promise);
    tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      done.resolve(undefined);
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/**
 * The factory database over one client, such as a PGlite instance in tests or a local proof. Its
 * start lock holds within this process only (the ledger's advisory lock needs a connection of its
 * own); close does nothing, since the caller owns the client.
 */
export function factoryDatabaseOver(input: { client: SqlClient; schema?: string; now: () => Date }): FactoryDatabase {
  const lock = keyedLock();
  return {
    ...ports(input.client, input.schema ?? "public", input.now),
    withStartLock: (scope, id, fn) => lock(`${scope}:${id}`, fn),
    close: () => Promise.resolve(),
  };
}

function poolClient(pool: pg.Pool): SqlClient {
  return {
    async query(text, params) {
      const result = await pool.query<Record<string, unknown>>(text, params);
      return { rows: result.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
}

/**
 * withFactoryLock on a connection of the lock pool, which goes back to the pool once the lock's
 * transaction ended, also after `fn` rejected; it is discarded when ending the transaction failed.
 */
async function lockOn<T>(locks: pg.Pool, scope: FactoryLockScope, id: string, fn: () => Promise<T>): Promise<T> {
  const connection = await locks.connect();
  // A connection lost while held fails its next statement; the listener keeps the error event from ending the process.
  const lost = (): void => undefined;
  connection.on("error", lost);
  const own: { failed: boolean; error: unknown } = { failed: false, error: undefined };
  let healthy = false;
  try {
    const result = await withFactoryLock(fromPg(connection), scope, id, async () => {
      try {
        return await fn();
      } catch (error) {
        own.failed = true;
        own.error = error;
        throw error;
      }
    });
    healthy = true;
    return result;
  } catch (error) {
    // `fn`'s own rejection ended the lock's transaction normally.
    healthy = own.failed && error === own.error;
    throw error;
  } finally {
    connection.off("error", lost);
    connection.release(!healthy);
  }
}

/**
 * The factory database named by `databaseUrl`, for the web service and the worker; the migrations
 * must already be applied there (in `schema`, default `public`). The first connect is the
 * controller's ledger connect (databaseLedger): retried for a transient failure, such as a
 * suspended compute waking, and otherwise LedgerError naming only DATABASE_URL and a driver error
 * code. The calls then run on a pool. The start locks hold connections of a pool of their own, so
 * starts that wait for a lock never take the connections the lock holder's calls need.
 */
export async function openFactoryDatabase(input: { databaseUrl: string; now: () => Date; log: FactoryLog; schema?: string }): Promise<FactoryDatabase> {
  const first = await databaseLedger(input.databaseUrl, input.now);
  await first.close();
  const config: pg.PoolConfig = { connectionString: input.databaseUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS };
  const calls = new pg.Pool(config);
  const locks = new pg.Pool(config);
  for (const pool of [calls, locks]) {
    // The pool drops a failed idle connection; a later call opens another.
    pool.on("error", () => {
      input.log("factory database: an idle connection failed and was dropped");
    });
  }
  let closing: Promise<void> | null = null;
  return {
    ...ports(poolClient(calls), input.schema ?? "public", input.now),
    withStartLock: (scope, id, fn) => lockOn(locks, scope, id, fn),
    close() {
      closing ??= Promise.all([calls.end(), locks.end()]).then(() => undefined);
      return closing;
    },
  };
}
