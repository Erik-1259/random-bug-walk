import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDocker } from "../../src/docker.ts";
import { tempDir } from "../support/synthetic.ts";

/** A stand-in for the docker binary: prints each argument on its own line, or misbehaves on request. */
function standIn(): string {
  const path = join(tempDir(), "docker");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  slow) sleep 5 ;;",
      '  fail) echo "synthetic failure" >&2; exit 3 ;;',
      '  *) printf "%s\\n" "$@" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

describe("the docker command layer", () => {
  it("passes every argument verbatim, with no shell, and captures stdout", async () => {
    const docker = createDocker(standIn());
    const result = await docker.run(["create", "--name", "rbw-synthetic", "/bin/sh", "-c", "echo $HOME; exit 3"]);
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout.toString().split("\n").slice(0, -1)).toEqual(["create", "--name", "rbw-synthetic", "/bin/sh", "-c", "echo $HOME; exit 3"]);
  });

  it("reports a non-zero exit with its stderr", async () => {
    const result = await createDocker(standIn()).run(["fail"]);
    expect(result).toMatchObject({ code: 3, stderr: "synthetic failure\n", timedOut: false });
  });

  it("stops a command at its timeout", async () => {
    const result = await createDocker(standIn()).run(["slow"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("streams stdout into a writable instead of buffering it", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    const result = await createDocker(standIn()).run(["cp", "rbw-synthetic:/workspace/app", "-"], { stdout: sink });
    expect(result.stdout.length).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("cp\nrbw-synthetic:/workspace/app\n-\n");
  });

  it("reports a missing binary as a failed command, not a crash", async () => {
    const result = await createDocker(join(tempDir(), "no-such-docker")).run(["version"]);
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
