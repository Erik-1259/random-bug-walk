// What the orchestrator needs from the outside world. The live implementations (live.ts) use the
// spend ledger in DATABASE_URL, Token Factory, a local Docker kit session and the controller's
// command line; the dry-run ones (fakes.ts) use a PGlite ledger, a scripted model, fake sessions
// and a fake controller, and make no live call.
import type { SolverSession } from "@rbw/solver";
import type { SubmitResult } from "@rbw/solver-session";
import type { Spend } from "@rbw/spend";
import type { FetchFunction } from "@rbw/writer";
import type { AllowanceSource } from "./allowance.ts";
import type { CaseConfig } from "./case.ts";

/** One attempt's session on the case's pinned kit image with the planted projection in place. */
export interface AttemptSession {
  /** The session as the solver loop's tool interface. */
  solver: SolverSession;
  /** The planted file the session placed and audited. */
  planted_sha256: string;
  /** The image digest the session ran. */
  digest: string;
  /** Takes the attempt's diff once, on submit or when the solver stopped at a cap. */
  end(reason: "submit" | "cap"): Promise<{ submission: SubmitResult; target: Buffer | null }>;
  /** Keeps the runtime logs and removes the container. */
  close(): Promise<void>;
}

export interface SessionRequest {
  /** Lower-case letters, digits and dashes; unique per attempt run. */
  id: string;
  /** An absent or empty directory. */
  work: string;
  /** The on arm: server_logs is served. */
  serverLogs: boolean;
  config: CaseConfig;
}

/** A session refused before any container (inputs, image digest or audit): the run stops, nothing is rerun. */
export class SessionRefused extends Error {
  override name = "SessionRefused";
}

/** The case's code states, derived from the pinned image and the probes. */
export interface CaseStates {
  target_path: string;
  digest: string;
  clean: Buffer;
  planted: Buffer;
  alternative: Buffer;
}

export interface Uc1Deps {
  spend: Spend;
  allowanceSource: AllowanceSource;
  /** The model's fetch: the platform fetch for a live run, a scripted one in a dry run. */
  fetch: FetchFunction;
  /** The solver role's Token Factory key, sent only as the bearer header. */
  apiKey?: string;
  openSession(request: SessionRequest): Promise<AttemptSession>;
  /**
   * Removes the container a session with this ID left behind (the process ended before close()),
   * so an interrupted run's session never outlives it. Resolves when no such container exists.
   */
  removeSession(id: string): Promise<void>;
  deriveStates(config: CaseConfig, work: string): Promise<CaseStates>;
  /** The content digest (local image ID) a local image reference resolves to now. */
  resolveImage(image: string): Promise<string>;
  /** Runs the controller with these `run` arguments; only its summary is trusted, never its exit code. */
  runController(args: readonly string[]): Promise<number>;
  /** The worst case of one grade 2 job (one Sandbox copy) from the committed rate sheet. */
  grade2WorstCaseMicrousd: bigint;
  uuid(): string;
  now(): Date;
  /** One line per step: outcomes, counts and IDs only, never issue text or transcripts. */
  report(line: string): void;
}
