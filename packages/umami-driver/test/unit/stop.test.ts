import { describe, expect, it } from "vitest";
import { STREAM_LIMIT_BYTES, captureStream, createProcessRunner, stopProcessGroup } from "../../src/process.ts";
import type { GroupControl } from "../../src/process.ts";
import { realTimers } from "../../src/limits.ts";
import { FakeTimers } from "../helpers.ts";

/** A process group that ends on the signals the test chooses, after the delay it chooses. */
function group(endsOn: ("SIGTERM" | "SIGKILL")[], timers: FakeTimers, delayMs = 0) {
  const sent: string[] = [];
  let endsAt: number | null = null;
  const control: GroupControl = {
    signal: (pgid, signal) => {
      sent.push(`${signal} -${String(pgid)}`);
      if (endsOn.includes(signal) && endsAt === null) endsAt = timers.now() + delayMs;
    },
    alive: () => endsAt === null || timers.now() < endsAt,
  };
  return { control, sent };
}

describe("stopping a process group", () => {
  it("sends TERM, waits, then KILL to a group that ignores TERM, and confirms it ended", async () => {
    const timers = new FakeTimers();
    const { control, sent } = group(["SIGKILL"], timers);
    const record = await stopProcessGroup(77, { control, timers, graceMs: 5000, killWaitMs: 2000, pollMs: 100 });
    expect(sent).toEqual(["SIGTERM -77", "SIGKILL -77"]);
    expect(record).toEqual({ pgid: 77, term_sent: true, kill_sent: true, ended: true, waited_ms: 5000 });
  });

  it("does not send KILL to a group that ends on TERM within the wait", async () => {
    const timers = new FakeTimers();
    const { control, sent } = group(["SIGTERM"], timers, 300);
    const record = await stopProcessGroup(78, { control, timers, graceMs: 5000, killWaitMs: 2000, pollMs: 100 });
    expect(sent).toEqual(["SIGTERM -78"]);
    expect(record).toMatchObject({ kill_sent: false, ended: true, waited_ms: 300 });
  });

  it("reports a group that survives KILL as not ended", async () => {
    const timers = new FakeTimers();
    const { control } = group([], timers);
    const record = await stopProcessGroup(79, { control, timers, graceMs: 1000, killWaitMs: 1000, pollMs: 100 });
    expect(record).toMatchObject({ term_sent: true, kill_sent: true, ended: false });
  });

  it("stops a real child group that ignores TERM", async () => {
    const runner = createProcessRunner(realTimers, { graceMs: 300, killWaitMs: 2000, pollMs: 20 });
    const controller = new AbortController();
    const running = runner.run({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin" },
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 300);
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.stop).toMatchObject({ term_sent: true, kill_sent: true, ended: true });
    expect(result.signal).toBe("SIGKILL");
  });
});

describe("bounded output", () => {
  it("keeps the first 1 MiB of a stream, counts the rest and marks it truncated", () => {
    const stream = captureStream(STREAM_LIMIT_BYTES);
    stream.push(Buffer.alloc(STREAM_LIMIT_BYTES - 10, 97));
    stream.push(Buffer.alloc(30, 98));
    const captured = stream.result();
    expect(captured.bytes.length).toBe(STREAM_LIMIT_BYTES);
    expect(captured.total_bytes).toBe(STREAM_LIMIT_BYTES + 20);
    expect(captured.truncated).toBe(true);
  });

  it("does not mark a stream within the limit", () => {
    const stream = captureStream(16);
    stream.push(Buffer.from("hello"));
    expect(stream.result()).toEqual({ bytes: Buffer.from("hello"), total_bytes: 5, truncated: false });
  });

  it("runs a command with only the environment it is given", async () => {
    const runner = createProcessRunner(realTimers);
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin", SYNTHETIC_ONLY: "1" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.bytes.toString("utf8"))).toEqual(["PATH", "SYNTHETIC_ONLY"]);
  });
});
