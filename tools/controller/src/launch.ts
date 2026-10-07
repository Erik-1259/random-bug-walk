// What the controller sees of one copy's launch. The copy runs through the local runner's
// run-copy path unchanged; the controller only wraps the Sandbox SDK and the Docker layer it
// injects there, to refuse a create once the child deadline no longer allows the copy, and to
// note whether a create was called, whether it returned a resource, and (on Docker) whether the
// container was removed. Nothing here retries or changes a call.
import type { CommandResult, Docker, SandboxSdk } from "@rbw/local-runner";

export class LaunchWatch {
  /** Called just before a create; false refuses it before the provider is called. */
  private readonly gate: () => boolean;
  refusedAtCreate = false;
  createCalled = false;
  created = false;
  /** The Docker container's name, from its create. */
  container: string | null = null;
  /** The Docker `rm --force` result: true when it exited 0, null when it was not run. */
  removed: boolean | null = null;
  /** When the create was called: the start of the copy's live-resource interval. */
  createdAtMs: number | null = null;
  private readonly now: () => number;

  constructor(gate: () => boolean, now: () => number = () => Date.now()) {
    this.gate = gate;
    this.now = now;
  }

  /** Whether a create may be called now; notes the refusal or the call. */
  admit(): boolean {
    if (!this.gate()) {
      this.refusedAtCreate = true;
      return false;
    }
    this.createCalled = true;
    this.createdAtMs = this.now();
    return true;
  }
}

export class CreateRefused extends Error {
  override name = "CreateRefused";

  constructor() {
    super("the controller refused the create: the child deadline no longer allows this copy");
  }
}

export function watchedSandbox(inner: SandboxSdk, watch: LaunchWatch): SandboxSdk {
  return {
    async create(params, options) {
      if (!watch.admit()) throw new CreateRefused();
      const sandbox = await inner.create(params, options);
      watch.created = true;
      return sandbox;
    },
    get: (name, options) => inner.get(name, options),
  };
}

/** A copy's container is the one created with the copy script (`rbw-copy`); the export container is not. */
function isCopyCreate(args: readonly string[]): boolean {
  return args[0] === "create" && args.includes("rbw-copy");
}

const REFUSED: CommandResult = { code: 125, stdout: Buffer.alloc(0), stderr: "refused by the controller: the child deadline no longer allows this copy\n", timedOut: false };

export function watchedDocker(inner: Docker, watch: LaunchWatch): Docker {
  return {
    async run(args, options) {
      if (isCopyCreate(args)) {
        if (!watch.admit()) return REFUSED;
        const result = await inner.run(args, options);
        watch.container = args[2] ?? null;
        watch.created = result.code === 0;
        return result;
      }
      const result = await inner.run(args, options);
      if (args[0] === "rm" && watch.container !== null && args.at(-1) === watch.container) watch.removed = result.code === 0;
      return result;
    },
  };
}
