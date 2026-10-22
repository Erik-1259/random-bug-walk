import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";

interface Notice { child?: number; descendant?: number; port?: number; requesting?: boolean; closing?: boolean; closed?: boolean; success?: boolean; releases?: number; samePromise?: boolean; listenersRestored?: boolean }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

function fixture(phase: string) {
  const child = spawn(process.execPath, [new URL("./fixtures/lifecycle-process.ts", import.meta.url).pathname, "driver", phase], { stdio: "pipe" });
  const notices: Notice[] = [];
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    for (const line of output.split("\n").slice(notices.length, -1)) notices.push(JSON.parse(line) as Notice);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  const done = once(child, "close").then(([exitCode, signal]: unknown[]) => ({ exitCode, signal }));
  const awaitNotice = async (predicate: (notice: Notice) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const notice = notices.find(predicate);
      if (notice) return notice;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Synthetic lifecycle exited before checkpoint: ${errors}`);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Synthetic lifecycle checkpoint timed out");
  };
  const cleanup = async () => {
    for (const notice of notices) if (notice.child !== undefined) {
      try { process.kill(-notice.child, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
  };
  return { child, done, notices, awaitNotice, cleanup };
}

async function assertGone(notice: Notice) {
  expect(notice.child).toBeTypeOf("number");
  expect(alive(notice.child ?? 0)).toBe(false);
  if (notice.descendant !== undefined && alive(notice.descendant)) {
    // An exited grandchild can await reaping by the host's init process.
    expect(execFileSync("ps", ["-o", "stat=", "-p", String(notice.descendant)], { encoding: "utf8" }).trim()).toMatch(/^Z/);
  }
  if (notice.port !== undefined) {
    const connection = connect(notice.port, "127.0.0.1");
    const result = await new Promise<string>(resolve => {
      connection.once("error", error => { resolve((error as NodeJS.ErrnoException).code ?? "UNKNOWN"); });
      connection.once("connect", () => { resolve("CONNECTED"); });
    });
    connection.destroy();
    expect(result).toBe("ECONNREFUSED");
  }
}

const interrupt = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => { expect(child.kill(signal)).toBe(true); };
for (const phase of ["startup", "poll", "request"]) for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it(`cleans the owned group during ${phase} on ${signal}`, async () => {
    const run = fixture(phase);
    try {
      const notice = await run.awaitNotice(value => value.descendant !== undefined);
      if (phase === "request") await run.awaitNotice(value => value.requesting === true);
      interrupt(run.child, signal);
      // A second interrupt must not restore default termination before cleanup finishes.
      await new Promise<void>(resolve => setTimeout(resolve, 40));
      interrupt(run.child, signal);
      expect(await run.done).toEqual({ exitCode: signal === "SIGINT" ? 130 : 143, signal: null });
      expect(run.notices.some(value => value.success)).toBe(false);
      await assertGone(notice);
    } finally { await run.cleanup(); }
  });
}

it("shares normal close and restores signal listeners", async () => {
  const run = fixture("normal");
  try {
    const notice = await run.awaitNotice(value => value.descendant !== undefined);
    expect(await run.done).toEqual({ exitCode: 0, signal: null });
    expect(run.notices).toContainEqual({ closed: true, releases: 1, samePromise: true, listenersRestored: true });
    await assertGone(notice);
  } finally { await run.cleanup(); }
});

it("finishes an already-running close before exiting for SIGTERM", async () => {
  const run = fixture("closing");
  try {
    const notice = await run.awaitNotice(value => value.descendant !== undefined);
    await run.awaitNotice(value => value.closing === true);
    interrupt(run.child, "SIGTERM");
    expect(await run.done).toEqual({ exitCode: 143, signal: null });
    expect(run.notices.some(value => value.success)).toBe(false);
    await assertGone(notice);
  } finally { await run.cleanup(); }
});

it("reaps an owned child that does not exit on SIGTERM", async () => {
  const run = fixture("resistant");
  try {
    const notice = await run.awaitNotice(value => value.child !== undefined);
    expect(await run.done).toEqual({ exitCode: 0, signal: null });
    await assertGone(notice);
  } finally { await run.cleanup(); }
}, 10_000);

it("kills a TERM-resistant descendant after its leader exits", async () => {
  const run = fixture("resistant-descendant");
  try {
    const notice = await run.awaitNotice(value => value.descendant !== undefined);
    expect(await run.done).toEqual({ exitCode: 0, signal: null });
    await assertGone(notice);
  } finally { await run.cleanup(); }
}, 10_000);
