// Live mode's worker launch for each backend, from the configuration: the image, the environment the
// launch passes and the environment the local worker command runs with. Nothing here launches a worker
// or opens a database.
import type * as FactoryLocal from "@rbw/controller/factory-local";
import { LOCAL_WORKER_IMAGE } from "@rbw/controller/factory-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryConfig } from "../../src/config.ts";
import { launchFor } from "../../src/factory-server/live/runtime.ts";
import { PASSCODE } from "../factory-server/support.ts";

/** What the local backend's worker sandboxes were built with. */
const local = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("@rbw/controller/factory-local", async (importOriginal) => {
  const actual = await importOriginal<typeof FactoryLocal>();
  const localWorkerSandbox: typeof actual.localWorkerSandbox = (input) => {
    local.inputs.push(input);
    return actual.localWorkerSandbox(input);
  };
  return { ...actual, localWorkerSandbox };
});

const IMAGE = `synthetic.invalid/rbw-factory-worker@sha256:${"a".repeat(64)}`;
const DATABASE_URL = "postgres://synthetic.invalid/factory";

const CONFIG: FactoryConfig = {
  mode: "live",
  passcode: PASSCODE,
  testFixturesDir: "/synthetic/fixtures",
  databaseUrl: DATABASE_URL,
  sandbox: { token: "synthetic-token", teamId: "synthetic-team", projectId: "synthetic-project" },
  workerImage: IMAGE,
  packagesDir: "/synthetic/packages",
  workerBackend: "sandbox",
  repoRoot: "/synthetic/repo",
};

afterEach(() => {
  vi.unstubAllEnvs();
  local.inputs.length = 0;
});

describe("the worker launch", () => {
  it("gives the sandbox backend the pinned image, and the worker the database, the Sandbox credentials and its own image", async () => {
    const launch = await launchFor(CONFIG, () => undefined);
    expect(launch?.config).toEqual({
      image: IMAGE,
      env: { DATABASE_URL, VERCEL_TOKEN: "synthetic-token", VERCEL_TEAM_ID: "synthetic-team", VERCEL_PROJECT_ID: "synthetic-project", RBW_FACTORY_WORKER_IMAGE: IMAGE },
    });
    expect(local.inputs).toEqual([]);
  });

  it("gives the local backend the local image and the database, and runs the worker command with the packages directory, PATH and HOME", async () => {
    vi.stubEnv("PATH", "/synthetic/bin");
    vi.stubEnv("HOME", "/synthetic/home");
    const launch = await launchFor({ ...CONFIG, workerBackend: "local" }, () => undefined);
    expect(launch?.config).toEqual({ image: LOCAL_WORKER_IMAGE, env: { DATABASE_URL } });
    expect(local.inputs).toEqual([{ repoRoot: "/synthetic/repo", env: { RBW_FACTORY_PACKAGES_DIR: "/synthetic/packages", PATH: "/synthetic/bin", HOME: "/synthetic/home" }, log: expect.any(Function) as unknown }]);
  });
});
