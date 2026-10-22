// Local mode: the bootstrap of a disposable factory ledger (on PGlite here; the local proof runs it
// on a throwaway Postgres) and its refusals, and the local worker sandbox, which runs the launch's
// factory-worker command as a child process of this one on the docker backend.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createSpend } from "@rbw/spend";
import { WORKER_RUN_ONCE_DIR, workerCommandArgs } from "../../src/factory-launch.ts";
import { LOCAL_POOL_CAP_MICROUSD, LOCAL_WORKER_IMAGE, LocalModeRefused, bootstrapFactoryLedger, isLoopbackDatabase, localWorkerSandbox, prepareFactoryLedger } from "../../src/factory-local.ts";
import type { WorkerSandboxCreateParams, WorkerSandboxInstance } from "../../src/factory-ports.ts";
import { runOnceCommand } from "../../src/factory-run-once.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const NOW = () => new Date("2026-10-20T19:00:00.000Z");

describe("the local factory ledger", () => {
  it("is bootstrapped once: every spend migration, the $40 factory pool and the factory slot key, then nothing more", async () => {
    const pglite = await PGlite.create();
    try {
      const first = await prepareFactoryLedger(pglite, NOW);
      expect(first.applied.at(-1)).toBe("0007_factory_validation_details.sql");
      expect([first.pool, first.slot_key]).toEqual(["created", "created"]);
      expect(await prepareFactoryLedger(pglite, NOW)).toEqual({ applied: [], pool: "present", slot_key: "present" });
      const spend = createSpend({ client: pglite, clock: NOW });
      const pool = await spend.poolStatus({ pool_key: "factory" });
      expect(pool.ok && pool.cap_microusd).toBe(BigInt(LOCAL_POOL_CAP_MICROUSD));
      const slot = await spend.slotStatus({ slot_key: "factory" });
      expect(slot.ok && slot.holder).toBeNull();
    } finally {
      await pglite.close();
    }
  });

  it("refuses on Vercel, and for a database that is not at a loopback address, before it connects", async () => {
    await expect(bootstrapFactoryLedger({ databaseUrl: "postgres://postgres@127.0.0.1:5432/postgres", env: { VERCEL_ENV: "preview" } })).rejects.toThrow(LocalModeRefused);
    const remote = bootstrapFactoryLedger({ databaseUrl: "postgres://owner:synthetic-secret@db.synthetic.invalid/factory", env: {} });
    await expect(remote).rejects.toThrow(LocalModeRefused);
    await expect(remote).rejects.not.toThrow(/synthetic-secret|db\.synthetic\.invalid/);
  });

  it("counts only a Postgres URL at a loopback address, with no host parameter elsewhere, as local", () => {
    for (const url of ["postgres://postgres@localhost:5432/db", "postgresql://u@127.0.0.1/db", "postgres://u@127.1.2.3:6543/db", "postgres://u@[::1]:5432/db"]) expect(isLoopbackDatabase(url)).toBe(true);
    for (const url of ["postgres://u@db.synthetic.invalid/db", "postgres://u@localhost.synthetic.invalid/db", "postgres://u@127.0.0.1.synthetic.invalid/db", "postgres://u@localhost/db?host=db.synthetic.invalid", "mysql://u@localhost/db", "not a url"]) {
      expect(isLoopbackDatabase(url)).toBe(false);
    }
  });
});

function createParams(name: string, databaseUrl: string): WorkerSandboxCreateParams {
  return { image: LOCAL_WORKER_IMAGE, name, persistent: false, networkPolicy: "allow-all", resources: { vcpus: 2 }, timeout: 120_000, env: { DATABASE_URL: databaseUrl } };
}

/** The command a launch sends: the worker command under the run-once guard, as startFactoryWorker builds it. */
function launchCommand(): { cmd: string; args: string[]; cwd: string; detached: true } {
  const guarded = runOnceCommand("rbw-worker", WORKER_RUN_ONCE_DIR, ["/usr/local/bin/node", ...workerCommandArgs({ request_id: randomUUID(), deadline_at: new Date(Date.now() + 3_600_000) })]);
  return { cmd: guarded.cmd, args: guarded.args, cwd: "/opt/rbw/repo", detached: true };
}

async function until(instance: WorkerSandboxInstance, status: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (instance.status !== status) {
    if (Date.now() > end) throw new Error(`synthetic: the sandbox stayed ${instance.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the local worker sandbox", () => {
  it("runs the launch's factory-worker command once, on the docker backend, as a child of this process", async () => {
    const logs: string[] = [];
    const sdk = localWorkerSandbox({ repoRoot: REPO_ROOT, env: { PATH: process.env.PATH ?? "" }, log: (line) => logs.push(line) });
    // Port 9 refuses the connection: the worker gets as far as opening the database.
    const instance = await sdk.create(createParams("rbw-fw-synthetic-a", "postgres://postgres@127.0.0.1:9/none"));
    await expect(sdk.create(createParams("rbw-fw-synthetic-a", "postgres://postgres@127.0.0.1:9/none"))).rejects.toMatchObject({ status: 409 });
    expect(await sdk.get("rbw-fw-synthetic-other")).toBeNull();
    expect(await instance.runCommand(launchCommand())).toEqual({ detached: true, started: true });
    expect((await sdk.get("rbw-fw-synthetic-a"))?.status).toBe("running");
    expect(await instance.runCommand(launchCommand())).toEqual({ detached: true, started: false });
    await until(instance, "stopped");
    // On the docker backend the worker reads no Vercel credential and fails only at the database.
    expect(logs.some((line) => line.includes("could not connect to the database named by DATABASE_URL"))).toBe(true);
    expect(logs.some((line) => line.includes("VERCEL_TOKEN"))).toBe(false);
    expect(logs.at(-1)).toBe("rbw-fw-synthetic-a: the worker command exited (code 2)");
  });

  it("stops a running worker's process group, and is stopped once the worker exited", async () => {
    // A server that accepts the database connection and never answers, so the worker waits in its connect.
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const logs: string[] = [];
      const sdk = localWorkerSandbox({ repoRoot: REPO_ROOT, env: { PATH: process.env.PATH ?? "" }, log: (line) => logs.push(line) });
      const instance = await sdk.create(createParams("rbw-fw-synthetic-b", `postgres://postgres@127.0.0.1:${String(port)}/none`));
      await instance.runCommand(launchCommand());
      const end = Date.now() + 60_000;
      while (sockets.length === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sockets.length).toBeGreaterThan(0);
      await instance.stop();
      expect(instance.status).toBe("stopping");
      await until(instance, "stopped");
      expect(logs.at(-1)).toBe("rbw-fw-synthetic-b: the worker command exited (signal SIGTERM)");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
