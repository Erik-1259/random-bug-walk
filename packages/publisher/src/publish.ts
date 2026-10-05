import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  RecordError,
  assertRecord,
  encodeCanonical,
  parseRecord,
  sha256Hex,
  type DefName,
  type DefTypes,
  type FailureReason,
  type ProjectPolicy,
  type PublicRunStatus,
  type PublicationRecord,
  type PublicationStatus,
  type RecordContext,
  type RootRun,
} from "@rbw/schema";
import { isInside, repositoryRoot, type Limits, type PublishConfig } from "./config.ts";
import { InvalidInput } from "./errors.ts";
import { MANIFEST_FILE, freeze, type Candidate, type FrozenFile } from "./freeze.ts";
import { Budget, LimitExceeded } from "./limits.ts";
import type { Logger } from "./log.ts";
import type { ProcessRunner } from "./process.ts";
import { Repository, RepositoryUnavailable, type RepositorySettings, type TreeEntry } from "./repository.ts";
import { parseRedactionValues, type RedactionValue } from "./sanitize.ts";
import { Scanner, combine } from "./scanner.ts";
import { readStaging } from "./staging.ts";
import { StateDir } from "./state.ts";
import { FilesystemStore, StoreError, VercelBlobStore, vercelBlobClient, type BlobClient, type FetchFunction, type PublicStore } from "./store.ts";

export interface PublishDeps {
  env: Readonly<Record<string, string | undefined>>;
  runner: ProcessRunner;
  blobClient?: BlobClient;
  fetch?: FetchFunction;
  logger: Logger;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EXIT = { published: 0, blocked: 1, failed: 2, status: 3, invalid: 4 } as const;

function readInput(path: string, code: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new InvalidInput(code);
  }
}

function parseInput<K extends DefName>(type: K, bytes: Uint8Array, code: string, context: RecordContext = {}): DefTypes[K] {
  try {
    return parseRecord(type, bytes, context);
  } catch (error) {
    if (error instanceof RecordError) throw new InvalidInput(code);
    throw error;
  }
}

/** Resolves symlinks in the longest existing prefix of a path. */
function realLocation(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    current = parent;
  }
  return resolve(realpathSync(current), ...rest);
}

function loadPolicy(config: PublishConfig): { policy: ProjectPolicy; sha256: string } {
  const bytes = readInput(config.policyFile, "policy_unreadable");
  const policy = parseInput("ProjectPolicy", bytes, "policy_invalid");
  if (!Buffer.from(encodeCanonical(policy)).equals(bytes)) throw new InvalidInput("policy_not_canonical");
  if (policy.purpose !== "public_demo" || policy.visibility !== "public") throw new InvalidInput("policy_not_public_demo");
  return { policy, sha256: sha256Hex(bytes) };
}

/**
 * A local remote runs its own receive hooks: git clears the -c options before starting
 * git-receive-pack. So a local remote must hold no executable hook and no hooksPath or include
 * setting that could point at one.
 */
function checkLocalRemoteHooks(remote: string): void {
  let config: string;
  try {
    config = readFileSync(join(remote, "config"), "utf8");
  } catch {
    throw new InvalidInput("local_remote_unreadable");
  }
  if (/^\s*hookspath\s*=/im.test(config) || /^\s*\[\s*include/im.test(config)) throw new InvalidInput("local_remote_hooks");
  const hooks = join(remote, "hooks");
  if (!existsSync(hooks)) return;
  for (const name of readdirSync(hooks)) {
    if (name.endsWith(".sample")) continue;
    const stats = statSync(join(hooks, name), { throwIfNoEntry: false });
    if (stats !== undefined && (stats.isDirectory() || (stats.mode & 0o111) !== 0)) throw new InvalidInput("local_remote_hooks");
  }
}

interface Destinations {
  store: PublicStore;
  repository: Omit<RepositorySettings, "gitDir">;
  ownerRepo: string;
}

function ownerAndRepo(url: string): { host: string; ownerRepo: string } {
  const parsed = new URL(url);
  return { host: parsed.host, ownerRepo: parsed.pathname.slice(1) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Builds the destinations. Credentials are read here, and only in real mode. */
function destinations(config: PublishConfig, policy: ProjectPolicy, deps: PublishDeps): Destinations {
  const repositoryUrl = policy.output_repository ?? "";
  const baseUri = policy.public_artifact_base_uri ?? "";
  const { host, ownerRepo } = ownerAndRepo(repositoryUrl);
  const destination = config.destination;
  if (destination.mode === "local") {
    for (const dir of [destination.remote, destination.store]) {
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) throw new InvalidInput("local_destination_missing");
    }
    checkLocalRemoteHooks(destination.remote);
    return {
      store: new FilesystemStore(destination.store, baseUri),
      repository: { readUrl: destination.remote, pushUrl: destination.remote, branch: config.branch, pushEnv: {} },
      ownerRepo,
    };
  }
  if (destination.repositoryUrl !== repositoryUrl || destination.artifactBaseUri !== baseUri) throw new InvalidInput("destination_differs_from_policy");
  if (host !== "github.com") throw new InvalidInput("repository_not_on_github");
  const keyPath = deps.env[destination.deployKeyEnv];
  const token = deps.env[destination.storeTokenEnv];
  if (keyPath === undefined || keyPath === "" || !isAbsolute(keyPath) || /[\0\n\r]/.test(keyPath)) throw new InvalidInput("deploy_key_unset");
  if (token === undefined || token === "") throw new InvalidInput("store_token_unset");
  // The key file is checked with stat only; its contents are never read.
  const key = statSync(keyPath, { throwIfNoEntry: false });
  if (key?.isFile() !== true) throw new InvalidInput("deploy_key_missing");
  if ((key.mode & 0o077) !== 0) throw new InvalidInput("deploy_key_permissions");
  const realKey = realLocation(keyPath);
  for (const dir of [repositoryRoot, config.stagingDir, config.stateDir]) {
    if (isInside(realKey, realLocation(dir))) throw new InvalidInput("deploy_key_location");
  }
  if (statSync(destination.knownHosts, { throwIfNoEntry: false })?.isFile() !== true) throw new InvalidInput("known_hosts_missing");
  const ssh = [
    "ssh",
    "-i",
    shellQuote(realKey),
    "-o IdentitiesOnly=yes",
    "-o BatchMode=yes",
    "-F /dev/null",
    "-o StrictHostKeyChecking=yes",
    `-o UserKnownHostsFile=${shellQuote(destination.knownHosts)}`,
  ].join(" ");
  return {
    store: new VercelBlobStore({ baseUri, token, client: deps.blobClient ?? vercelBlobClient, fetch: deps.fetch ?? fetch }),
    repository: { readUrl: repositoryUrl, pushUrl: `git@github.com:${ownerRepo}.git`, branch: config.branch, pushEnv: { GIT_SSH_COMMAND: ssh } },
    ownerRepo,
  };
}

function checkStateLocation(config: PublishConfig): void {
  const state = realLocation(config.stateDir);
  const forbidden = [repositoryRoot, config.stagingDir];
  if (config.destination.mode === "local") forbidden.push(config.destination.remote, config.destination.store);
  for (const dir of forbidden) {
    if (isInside(state, realLocation(dir)) || isInside(realLocation(dir), state)) throw new InvalidInput("state_location");
  }
}

function printLocations(deps: PublishDeps, locations: readonly string[]): void {
  for (const location of locations) deps.stderr(`${location}\n`);
}

function publicStatus(root: RootRun, policySha256: string, publication: PublicationStatus | null): PublicRunStatus {
  return assertRecord(
    "PublicRunStatus",
    {
      schema_version: 1,
      root_execution_id: root.root_execution_id,
      project_policy_sha256: policySha256,
      kind: root.kind,
      status: root.status,
      outcome: root.outcome,
      declared_stage_count: root.declared_stages.length,
      child_execution_count: root.child_execution_ids.length,
      publication_status: publication,
    },
    { root },
  );
}

interface Attempt {
  status: "published" | "blocked" | "failed";
  failureReason: FailureReason | null;
  commit: string | null;
  locations: string[];
}

const failed = (failureReason: FailureReason): Attempt => ({ status: "failed", failureReason, commit: null, locations: [] });

class Publisher {
  private readonly config: PublishConfig;
  private readonly deps: PublishDeps;
  private readonly root: RootRun;
  private readonly state: StateDir;
  private readonly scanner: Scanner;
  private readonly store: PublicStore;
  private readonly repositorySettings: RepositorySettings;

  constructor(config: PublishConfig, deps: PublishDeps, root: RootRun, state: StateDir, scanner: Scanner, target: Destinations) {
    this.config = config;
    this.deps = deps;
    this.root = root;
    this.state = state;
    this.scanner = scanner;
    this.store = target.store;
    this.repositorySettings = { ...target.repository, gitDir: state.repositoryDir };
  }

  private get rootId(): string {
    return this.root.root_execution_id;
  }

  private get commitMessage(): string {
    return `chore(runs): publish ${this.rootId}`;
  }

  /** Re-reads the frozen bytes and checks them against their hashes. */
  private frozenTree(candidate: Candidate): Map<string, Uint8Array> | null {
    const tree = new Map<string, Uint8Array>();
    if (sha256Hex(candidate.manifestBytes) !== candidate.manifestSha256) return null;
    tree.set(`runs/${this.rootId}/${MANIFEST_FILE}`, candidate.manifestBytes);
    for (const file of candidate.files) {
      let bytes: Buffer;
      try {
        bytes = this.state.readBlob(this.rootId, candidate.publicationId, file.sha256);
      } catch {
        return null;
      }
      if (bytes.length !== file.size_bytes || sha256Hex(bytes) !== file.sha256) return null;
      tree.set(`runs/${this.rootId}/${file.path}`, bytes);
    }
    return tree;
  }

  /** Reads an object back without credentials. Transfer counts the bytes actually received. */
  private async readObject(file: FrozenFile, budget: Budget): Promise<"present" | "missing"> {
    const key = `sha256/${file.sha256}`;
    budget.checkAll({ storeOperations: 1, transferBytes: file.size_bytes });
    budget.spend("storeOperations", 1);
    this.deps.logger.event("store_read", { key });
    const bytes = await this.store.read(key);
    if (bytes === null) return "missing";
    budget.spend("transferBytes", Math.min(bytes.length, file.size_bytes));
    if (bytes.length !== file.size_bytes || sha256Hex(bytes) !== file.sha256) throw new StoreError("store_mismatch");
    return "present";
  }

  /**
   * Makes sure every large object is in the store with the right bytes, uploading only missing
   * ones. Before the first upload it checks that the uploads, their read-back and `after` (what
   * the rest of the attempt needs) all fit the limits, so a run that cannot finish uploads nothing.
   */
  private async ensureObjects(candidate: Candidate, budget: Budget, tree: ReadonlyMap<string, Uint8Array>, after: Partial<Limits>): Promise<void> {
    const unique = [...new Map(candidate.files.filter((item) => item.large).map((item) => [item.sha256, item])).values()];
    const missing: FrozenFile[] = [];
    for (const file of unique) {
      if ((await this.readObject(file, budget)) === "missing") missing.push(file);
      else this.deps.logger.event("store_reuse", { key: `sha256/${file.sha256}` });
    }
    const missingBytes = missing.reduce((total, file) => total + file.size_bytes, 0);
    budget.checkAll({
      ...after,
      newPublicBytes: missingBytes + (after.newPublicBytes ?? 0),
      transferBytes: 2 * missingBytes + (after.transferBytes ?? 0),
      storeOperations: 2 * missing.length + (after.storeOperations ?? 0),
    });
    for (const file of missing) {
      const key = `sha256/${file.sha256}`;
      const bytes = tree.get(`runs/${this.rootId}/${file.path}`);
      if (bytes === undefined) throw new StoreError("store_unavailable");
      budget.spend("newPublicBytes", file.size_bytes);
      budget.spend("transferBytes", file.size_bytes);
      budget.spend("storeOperations", 1);
      this.deps.logger.event("store_put", { key, size: file.size_bytes });
      await this.store.create(key, bytes, file.media_type);
      if ((await this.readObject(file, budget)) === "missing") throw new StoreError("store_mismatch");
    }
  }

  private async attempt(candidate: Candidate, budget: Budget): Promise<Attempt> {
    const tree = this.frozenTree(candidate);
    if (tree === null) return failed("candidate_corrupt");

    // PUB-02: scan exactly the bytes that become public, and publish nothing unless both scans are clean.
    const scan = combine([await this.scanner.scanTree(tree), await this.scanner.scanText("commit-message", new TextEncoder().encode(this.commitMessage))]);
    if (scan.outcome === "blocked") return { status: "blocked", failureReason: "scan_blocked", commit: null, locations: scan.locations };
    if (scan.outcome === "unavailable") return failed("scan_unavailable");

    const prefix = `runs/${this.rootId}/`;
    const entries: TreeEntry[] = [
      { path: MANIFEST_FILE, bytes: candidate.manifestBytes },
      ...candidate.files.filter((file) => !file.large).map((file) => ({ path: file.path, bytes: tree.get(`${prefix}${file.path}`) ?? new Uint8Array() })),
    ];
    const payload = entries.reduce((total, entry) => total + entry.bytes.length, 0);
    // The repository payload becomes public once, however many pushes it takes.
    const payloadTag = `repository:${candidate.manifestSha256}`;
    const repository = new Repository(this.repositorySettings, this.deps.runner, this.deps.env, this.deps.logger, budget);
    try {
      // The remote is inspected before any push-limit check, so a push that landed without being
      // recorded is still found after the last allowed attempt.
      await repository.init();
      const head = await repository.fetchHead();
      if (head !== null) {
        const existing = await repository.treeAt(head, `runs/${this.rootId}`);
        if (existing !== null) {
          if (existing !== (await repository.runTree(entries))) return failed("repository_conflict");
          await this.ensureObjects(candidate, budget, tree, {});
          return { status: "published", failureReason: null, commit: await repository.addedBy(head, `${prefix}${MANIFEST_FILE}`), locations: [] };
        }
      }
      // A root with no push attempt left reads and uploads nothing more.
      budget.check("pushAttempts", 1);
      await this.ensureObjects(candidate, budget, tree, {
        pushAttempts: 1,
        newPublicBytes: budget.hasCounted(payloadTag) ? 0 : payload,
        transferBytes: payload,
      });
      const commit = await repository.commit(head, prefix, entries, this.commitMessage);
      budget.spendOnce("newPublicBytes", payload, payloadTag);
      budget.spend("transferBytes", payload);
      if (!(await repository.push(commit))) return failed("repository_unavailable");
      return { status: "published", failureReason: null, commit, locations: [] };
    } catch (error) {
      if (error instanceof LimitExceeded) return failed("limit_exceeded");
      if (error instanceof StoreError) return failed(error.code);
      if (error instanceof RepositoryUnavailable) return failed("repository_unavailable");
      throw error;
    }
  }

  private record(candidate: Candidate, attempt: Attempt | null): PublicationRecord {
    const status = attempt?.status ?? "prepared";
    return assertRecord(
      "PublicationRecord",
      {
        schema_version: 1,
        root_execution_id: this.rootId,
        project_policy_sha256: this.root.project_policy_sha256,
        publication_id: candidate.publicationId,
        manifest_sha256: candidate.manifestSha256,
        execution_id: this.rootId,
        status,
        repository_commit: attempt?.commit ?? null,
        artifacts: status === "blocked" ? [] : candidate.artifacts,
        omissions: candidate.omissions,
        failure_reason: attempt?.failureReason ?? null,
      },
      { root: this.root },
    );
  }

  /** Scans the status object on its own, then writes it. Problems go to stderr only. */
  private async writeStatus(record: PublicationRecord, budget: Budget): Promise<void> {
    const status = publicStatus(this.root, this.root.project_policy_sha256, record.status);
    const bytes = encodeCanonical(status);
    const scan = await this.scanner.scanText("public-run-status", bytes);
    if (scan.outcome !== "clean") {
      this.deps.stderr(`status object not written: scan ${scan.outcome}\n`);
      return;
    }
    try {
      budget.spend("storeOperations", 1);
      await this.store.writeStatus(`status/${this.rootId}.json`, bytes);
      this.deps.logger.event("status_written", { root: this.rootId, publication_status: record.status });
    } catch (error) {
      if (!(error instanceof LimitExceeded) && !(error instanceof StoreError)) throw error;
      this.deps.stderr(`status object not written: ${error instanceof StoreError ? error.code : "limit_exceeded"}\n`);
    }
  }

  private print(record: PublicationRecord): number {
    return printRecord(this.deps, record);
  }

  private freezeCandidate(policy: ProjectPolicy, policySha256: string, values: readonly RedactionValue[]): ReturnType<typeof freeze> {
    const staged = readStaging(this.config.stagingDir, this.root, values);
    return freeze({
      policy,
      policySha256,
      root: this.root,
      staged,
      values,
      baseUri: policy.public_artifact_base_uri ?? "",
      largeObjectThreshold: this.config.largeObjectThreshold,
    });
  }

  async run(policy: ProjectPolicy, policySha256: string): Promise<number> {
    const currentId = this.state.currentPublicationId(this.rootId);
    const current = currentId === null ? null : this.state.loadRecord(this.rootId, currentId);
    if (current?.status === "published") {
      if (this.config.replace) throw new InvalidInput("replace_published");
      return this.print(current);
    }
    if (this.config.replace && current?.status !== "blocked") throw new InvalidInput("replace_not_blocked");

    let candidate: Candidate;
    let record: PublicationRecord;
    if (current === null || this.config.replace) {
      // The values file is read only while freezing, and staging is never read again afterwards.
      const values = this.config.redactionValuesFile === null ? [] : parseRedactionValues(readInput(this.config.redactionValuesFile, "redaction_values_unreadable"));
      const frozen = this.freezeCandidate(policy, policySha256, values);
      candidate = frozen.candidate;
      if (current !== null && candidate.publicationId === current.publication_id) throw new InvalidInput("replacement_identical");
      this.state.ensure();
      this.state.saveCandidate(this.rootId, frozen);
      record = this.record(candidate, null);
      this.state.saveRecord(record);
      this.state.setCurrent(this.rootId, candidate.publicationId);
      this.deps.logger.event("frozen", { root: this.rootId, publication: candidate.publicationId, files: candidate.files.length });
    } else {
      const loaded = this.state.loadCandidate(this.rootId, current.publication_id);
      if (loaded?.publicationId !== current.publication_id || loaded.manifestSha256 !== current.manifest_sha256) {
        // The frozen candidate no longer matches its record: publish nothing and keep the record's IDs.
        record = assertRecord("PublicationRecord", { ...current, status: "failed", repository_commit: null, failure_reason: "candidate_corrupt" }, { root: this.root });
        this.state.saveRecord(record);
        await this.writeStatus(record, new Budget(this.state, this.rootId, this.config.limits));
        return this.print(record);
      }
      candidate = loaded;
      record = current;
    }

    // Reaching a limit stops automatic attempts; nothing is contacted again.
    if (record.failure_reason === "limit_exceeded") return this.print(record);

    const budget = new Budget(this.state, this.rootId, this.config.limits);
    const attempt = await this.attempt(candidate, budget);
    record = this.record(candidate, attempt);
    this.state.saveRecord(record);
    this.deps.logger.event("record", { root: this.rootId, publication: record.publication_id, status: record.status, reason: record.failure_reason });
    if (attempt.status === "blocked") printLocations(this.deps, attempt.locations);
    await this.writeStatus(record, budget);
    return this.print(record);
  }
}

function printRecord(deps: PublishDeps, record: PublicationRecord): number {
  deps.stdout(`${new TextDecoder().decode(encodeCanonical(record))}\n`);
  return record.status === "published" ? EXIT.published : record.status === "blocked" ? EXIT.blocked : EXIT.failed;
}

/** The publish command. Every validation happens before anything is written. */
export async function publishCommand(config: PublishConfig, deps: PublishDeps): Promise<number> {
  const { policy, sha256: policySha256 } = loadPolicy(config);
  const root = parseInput("RootRun", readInput(config.rootRunFile, "root_run_unreadable"), "root_run_invalid", { policy });
  const target = destinations(config, policy, deps);
  checkStateLocation(config);
  const scanner = new Scanner(
    { command: config.scanner, gitleaks: config.gitleaks, patternFile: config.patternFile, repository: target.ownerRepo, timeoutMs: config.scanTimeoutMs },
    deps.runner,
    deps.env,
    deps.logger,
  );

  const state = new StateDir(config.stateDir);
  if (root.status !== "terminal") {
    // A root that has been through a terminal call keeps the status that call wrote.
    const currentId = state.currentPublicationId(root.root_execution_id);
    if (currentId !== null) {
      deps.stderr("status not written: root already terminal\n");
      return printRecord(deps, state.loadRecord(root.root_execution_id, currentId));
    }
    // Staging is not read; only the status object is scanned and written, within the root's limits.
    const bytes = encodeCanonical(publicStatus(root, policySha256, null));
    const scan = await scanner.scanText("public-run-status", bytes);
    if (scan.outcome === "blocked") {
      printLocations(deps, scan.locations);
      return EXIT.blocked;
    }
    if (scan.outcome === "unavailable") return EXIT.failed;
    try {
      state.ensure();
      new Budget(state, root.root_execution_id, config.limits).spend("storeOperations", 1);
      await target.store.writeStatus(`status/${root.root_execution_id}.json`, bytes);
    } catch (error) {
      if (!(error instanceof StoreError) && !(error instanceof LimitExceeded)) throw error;
      deps.stderr(`status object not written: ${error instanceof StoreError ? error.code : "limit_exceeded"}\n`);
      return EXIT.failed;
    }
    deps.stdout(`${new TextDecoder().decode(bytes)}\n`);
    return EXIT.status;
  }

  return new Publisher(config, deps, root, state, scanner, target).run(policy, policySha256);
}
