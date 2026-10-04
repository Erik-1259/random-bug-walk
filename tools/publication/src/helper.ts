import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { HELPER_USAGE, loadHelperConfig, type HelperConfig } from "./config.ts";
import { Inbox, InboxChanged } from "./inbox.ts";
import { HostLog } from "./log.ts";
import { ChildTimedOut, type Decision, type OperationContext } from "./operation.ts";
import { buildResponse, parseRequest, type PublicationRequest, type PublicationResponse } from "./protocol.ts";
import { publishPullRequest } from "./pull-request.ts";
import { publishPush } from "./push.ts";
import { localRemotePath, readRegistry, validateEntry, type WorktreeEntry } from "./registry.ts";
import { runProcess, toolEnvironment } from "./run.ts";
import { StateStore } from "./state.ts";

const MINIMUM_GIT: readonly [number, number, number] = [2, 45, 1];
const REQUEST_FILE = /^([A-Za-z0-9-]{8,64})\.json$/;
/** Starts of work on one request, without a push or post attempt, before it is answered unavailable. */
const MAX_STARTS = 3;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** The real path of a file or of its nearest existing ancestor, joined with the rest. */
async function realish(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    return parent === path ? path : join(await realish(parent), basename(path));
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Agent-chosen text for the host log: printable ASCII only, everything else as "?". */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

/** Compares a request token with the registered one in constant time, whatever their lengths. */
function tokenMatches(given: string | undefined, registered: string): boolean {
  if (given === undefined) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(registered));
}

async function gitVersionOk(env: Record<string, string>, cwd: string, timeoutMs: number): Promise<boolean> {
  const result = await runProcess("git", ["version"], { cwd, env, timeoutMs });
  const match = /git version (\d+)\.(\d+)\.(\d+)/.exec(result.stdout.toString("utf8"));
  if (result.code !== 0 || match === null) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, minimum] of MINIMUM_GIT.entries()) {
    const part = version[index] ?? 0;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

/** The inbox and every registered working copy: places agents can write. */
async function agentLocations(config: HelperConfig, worktrees: Record<string, unknown> | null): Promise<string[]> {
  const locations = [await realish(config.inboxRoot)];
  for (const entry of Object.values(worktrees ?? {})) {
    if (typeof entry === "object" && entry !== null && "path" in entry && typeof entry.path === "string" && isAbsolute(entry.path)) {
      locations.push(await realish(entry.path));
    }
  }
  return locations;
}

/** Host-only files that must lie outside the inbox and every registered working copy. */
async function unsafeLocations(config: HelperConfig, worktrees: Record<string, unknown> | null): Promise<boolean> {
  const protectedPaths = await Promise.all([config.registryPath, config.patternFile, config.stateDir].map(realish));
  const forbidden = await agentLocations(config, worktrees);
  return protectedPaths.some((path) => forbidden.some((parent) => isInside(path, parent)));
}

/** True when a local remote lies inside a place agents can write, where its hooks and config would run. */
async function remoteInAgentLocation(config: HelperConfig, worktrees: Record<string, unknown>, entry: WorktreeEntry): Promise<boolean> {
  const local = localRemotePath(entry.remote);
  if (local === null) return false;
  const path = await realish(local);
  return (await agentLocations(config, worktrees)).some((parent) => isInside(path, parent));
}

class PublicationHelper {
  private readonly config: HelperConfig;
  private readonly log: HostLog;
  private readonly inbox: Inbox;
  private readonly state: StateStore;
  private readonly env = toolEnvironment(process.env);
  private readonly remoteEnv: Record<string, string>;
  private readonly reportedNames = new Set<string>();
  stopping = false;

  isStopping(): boolean {
    return this.stopping;
  }

  constructor(config: HelperConfig, log: HostLog, inbox: Inbox, state: StateStore) {
    this.config = config;
    this.log = log;
    this.inbox = inbox;
    this.state = state;
    this.remoteEnv = toolEnvironment(process.env, config.passEnv);
  }

  /** Answers again, from the record, every finished request whose response file is missing. */
  async rewriteMissingResponses(): Promise<void> {
    for (const id of await this.state.recordedIds()) {
      if (await this.inbox.responseExists(id)) continue;
      const record = await this.state.readRecord(id);
      if (record !== null) await this.respond(record, "rewritten");
    }
  }

  /**
   * One poll: adopt claimed files, finish stored requests, then claim new ones oldest
   * first. Throws InboxChanged when an inbox directory is no longer the one recorded at start.
   */
  async pass(): Promise<void> {
    if (!(await this.inbox.verify())) throw new InboxChanged();
    for (const entry of await this.inbox.listClaimed()) {
      const id = REQUEST_FILE.exec(entry.name)?.[1];
      if (id === undefined || (await this.state.hasStored(id))) continue;
      await this.storeClaimed(id, entry.name);
    }
    await this.finishStored();
    while (!this.stopping) {
      const next = await this.nextRequest();
      if (next === null) break;
      const claimed = await this.inbox.claim(next.name);
      if (claimed === "gone") continue;
      if (claimed === "failed") {
        this.reportedNames.add(next.name);
        this.log.event("request could not be claimed; skipped until restart", { request: next.id });
        continue;
      }
      if (await this.state.hasStored(next.id)) {
        const record = await this.state.readRecord(next.id);
        if (record !== null) await this.respond(record, "replayed");
        continue;
      }
      await this.storeClaimed(next.id, next.name);
      await this.finishStored();
    }
  }

  private async nextRequest(): Promise<{ id: string; name: string } | null> {
    for (const entry of await this.inbox.listRequests()) {
      if (this.reportedNames.has(entry.name)) continue;
      const id = REQUEST_FILE.exec(entry.name)?.[1];
      if (id !== undefined) return { id, name: entry.name };
      this.reportedNames.add(entry.name);
      this.log.event("invalid request file name; not answered", { name: printable(entry.name.slice(0, 80)) });
    }
    return null;
  }

  /** Reads a claimed file exactly once and stores its bytes; later work uses only the stored copy. */
  private async storeClaimed(id: string, name: string): Promise<void> {
    const read = await this.inbox.readClaimed(name);
    if (read === null) return;
    await this.state.store(id, read.kind === "bytes" ? read.bytes : new Uint8Array());
  }

  private async finishStored(): Promise<void> {
    for (const id of await this.state.storedIds()) {
      if (this.stopping) return;
      if ((await this.state.readRecord(id)) !== null) continue;
      await this.process(id);
    }
  }

  private async process(id: string): Promise<void> {
    const request = parseRequest(await this.state.readStored(id), id);
    if (request === null) {
      await this.finish(buildResponse(id, null, "blocked"), { category: "invalid-request" });
      return;
    }
    const fields = { worktree: request.worktreeId, operation: request.operation };
    // A request that keeps ending the helper is answered, unless a push or post may have happened.
    if ((await this.state.countStart(id)) >= MAX_STARTS && !(await this.state.hasAttempt(id))) {
      await this.finish(buildResponse(id, request.sha, "unavailable"), { ...fields, category: "too-many-attempts" });
      return;
    }
    let decision: Decision;
    try {
      decision = await this.decide(request);
    } catch (error) {
      // An unexpected error after a push or post might hide a publication, so it stays pending.
      const category = error instanceof ChildTimedOut ? "timeout" : "internal-error";
      decision = { outcome: (await this.state.hasAttempt(id)) ? "pending" : "unavailable", category };
      if (!(error instanceof ChildTimedOut)) this.log.event("request failed", { request: id, error: error instanceof Error ? error.name : "unknown" });
    }
    if (decision.outcome === "pending") {
      this.log.write({ request: id, ...fields, outcome: "pending", category: decision.category, requested: request.sha });
      return;
    }
    await this.finish(buildResponse(id, request.sha, decision.outcome, decision.locations), {
      ...fields,
      category: decision.category,
      pr: decision.pullRequest,
    });
  }

  private async decide(request: PublicationRequest): Promise<Decision> {
    // After a push or post attempt, only the operation's own resume check may settle the request.
    const attempted = await this.state.hasAttempt(request.requestId);
    const refuse = (outcome: "unavailable" | "blocked", category: string): Decision =>
      attempted ? { outcome: "pending", category } : { outcome, category };
    const worktrees = await readRegistry(this.config.registryPath);
    if (worktrees === null) return refuse("unavailable", "registry");
    if (await unsafeLocations(this.config, worktrees)) return refuse("unavailable", "unsafe-configuration");
    if (!Object.hasOwn(worktrees, request.worktreeId)) return refuse("blocked", "unknown-worktree");
    const entry = await validateEntry(worktrees[request.worktreeId], this.state.dir, this.env);
    if (entry === null || (await remoteInAgentLocation(this.config, worktrees, entry))) return refuse("blocked", "invalid-registration");
    if (!tokenMatches(request.token, entry.token)) return refuse("blocked", "invalid-token");
    const context: OperationContext = { config: this.config, state: this.state, request, entry, env: this.env, remoteEnv: this.remoteEnv };
    return request.operation === "push" ? publishPush(context) : publishPullRequest(context);
  }

  /** Records the outcome in the state directory, then answers it in the inbox. */
  private async finish(
    response: PublicationResponse,
    fields: { worktree?: string; operation?: string; category: string; pr?: number | undefined },
  ): Promise<void> {
    await this.state.writeRecord(response);
    this.log.write({
      request: response.requestId,
      worktree: fields.worktree,
      operation: fields.operation,
      outcome: response.outcome,
      category: fields.category,
      requested: response.requestedSha,
      published: response.publishedSha,
      pr: fields.pr,
    });
    await this.respond(response, null);
  }

  private async respond(response: PublicationResponse, reason: string | null): Promise<void> {
    await this.inbox.writeResponse(response.requestId, Buffer.from(`${JSON.stringify(response)}\n`));
    if (reason !== null) this.log.event(`response ${reason} from record`, { request: response.requestId, outcome: response.outcome });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const config = loadHelperConfig(argv, process.env, process.cwd());
  if (typeof config === "string") {
    process.stderr.write(`${config}\n${HELPER_USAGE}\n`);
    return 2;
  }
  const env = toolEnvironment(process.env);
  if (!(await gitVersionOk(env, "/", config.timeouts.git))) {
    process.stderr.write("refusing to start: git 2.45.1 or later is required\n");
    return 2;
  }
  let unsafe: boolean;
  try {
    unsafe = await unsafeLocations(config, await readRegistry(config.registryPath));
  } catch {
    // The error would name a host path, possibly the pattern file's; only a generic line is printed.
    unsafe = true;
  }
  if (unsafe) {
    process.stderr.write(
      "refusing to start: the registry, pattern file and state directory must resolve, and lie outside the inbox and every registered working copy\n",
    );
    return 2;
  }
  const state = new StateStore(config.stateDir);
  await state.init();
  const lock = await state.lock();
  if (lock !== "locked") {
    process.stderr.write(
      lock === "held"
        ? "refusing to start: another helper is using this state directory\n"
        : "refusing to start: helper.lock.takeover exists in the state directory; remove it once no helper is starting\n",
    );
    return 2;
  }
  try {
    return await run(config, state);
  } finally {
    await state.unlock();
  }
}

async function run(config: HelperConfig, state: StateStore): Promise<number> {
  const log = new HostLog(state.logFile);
  const inbox = new Inbox(config.inboxRoot, state.claimedDirectory);
  const helper = new PublicationHelper(config, log, inbox, state);
  const prepared = await inbox.prepare();
  if (prepared !== "ok") {
    log.event(
      prepared === "invalid"
        ? "inbox layout invalid; nothing written"
        : "inbox requests and the state directory are on different devices; nothing written",
    );
    return 1;
  }
  /** Logs a failed unit of work; true when it failed because an inbox directory changed. */
  const changed = (error: unknown): boolean => {
    if (error instanceof InboxChanged) {
      log.event("inbox directory changed; serving stopped");
      return true;
    }
    log.event("poll failed", { error: error instanceof Error ? error.name : "unknown" });
    return false;
  };
  try {
    await helper.rewriteMissingResponses();
  } catch (error) {
    if (changed(error)) return 1;
  }
  if (config.mode === "once") {
    try {
      await helper.pass();
      return 0;
    } catch (error) {
      changed(error);
      return 1;
    }
  }

  const sleeper: { wake: (() => void) | null } = { wake: null };
  const stop = (): void => {
    helper.stopping = true;
    sleeper.wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log.event("serving", { interval: config.pollIntervalMs });
  while (!helper.stopping) {
    try {
      await helper.pass();
    } catch (error) {
      if (changed(error)) return 1;
    }
    if (helper.isStopping()) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      sleeper.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    sleeper.wake = null;
  }
  log.event("stopped");
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
