import { describe, expect, it } from "vitest";
import { contaminationHits, isContaminated } from "../../src/contamination.ts";

describe("the contamination check", () => {
  it.each([
    ["node .next/standalone/server.js &", "starts_server"],
    ["npx next dev -p 3001", "starts_server"],
    ["pnpm run start", "starts_server"],
    ["npm start", "starts_server"],
    ["sudo rbw-start", "starts_server"],
    ["postgres -D /tmp/db", "starts_server"],
    ["cat /var/lib/rbw/logs/umami.stderr.log", "reads_process_output"],
    ["ls -l /proc/123/fd", "reads_process_output"],
    ["strace -p 42", "reads_process_output"],
  ])("flags %s", (command, kind) => {
    expect(contaminationHits([command]).map((hit) => hit.kind)).toContain(kind);
  });

  it.each(["ls src", "grep -rn timezone src/lib", "pnpm test", "node -e 'console.log(1)'", "cat package.json"])("does not flag %s", (command) => {
    expect(isContaminated([command])).toBe(false);
  });

  it("names the command index of each hit", () => {
    expect(contaminationHits(["ls", "cat /var/lib/rbw/logs/x"])).toEqual([
      { kind: "reads_process_output", command_index: 1, pattern: "rbw log directory" },
    ]);
  });
});
