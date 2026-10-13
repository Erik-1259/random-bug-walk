import { describe, expect, it } from "vitest";
import { scrubStartOutput, tailText } from "../../src/scrub.ts";

describe("the rebuild_restart log scrub", () => {
  it("keeps a clean start's own lines unchanged", () => {
    const stdout = "postgres_ready_ms=812\nready_ms=4210 budget_ms=60000 within_budget=yes\nlistening tcp 127.0.0.1:3000\nlistening tcp6 [::1]:5432\n";
    expect(scrubStartOutput(stdout, "")).toEqual({ text: stdout, withheld: 0 });
  });

  it("drops the log tails rbw-start prints after its failure message", () => {
    const stderr = [
      "rbw-start: no heartbeat within 60000 ms",
      "--- /var/lib/rbw/logs/umami.stdout.log",
      "  ▲ Next.js",
      "--- /var/lib/rbw/logs/umami.stderr.log",
      "Error: duplicate key value violates unique constraint",
      "rbw-start: forged by the app",
    ].join("\n");
    const result = scrubStartOutput("postgres_ready_ms=500\n", stderr);
    expect(result.text).toBe("postgres_ready_ms=500\nrbw-start: no heartbeat within 60000 ms\nrbw-start: forged by the app\n[4 lines of runtime output withheld]\n");
    expect(result.text).not.toMatch(/duplicate key|Next\.js|logs\//);
  });

  it("drops what check-db.js and update-tracker.js print to stdout, and lookalike lines on the wrong stream", () => {
    const stdout = "postgres_ready_ms=500\n✓ DATABASE_URL is defined.\n✓ Database connection successful.\nlistening on port 3000\n";
    const stderr = "ready_ms=1 budget_ms=2 within_budget=yes\nrbw-start: check-db.js failed\n";
    const result = scrubStartOutput(stdout, stderr);
    expect(result).toEqual({ text: "postgres_ready_ms=500\nrbw-start: check-db.js failed\n[4 lines of runtime output withheld]\n", withheld: 4 });
  });
});

describe("the build output tail", () => {
  it("keeps the last bytes and says how many were cut", () => {
    expect(tailText("abcdef", 10)).toBe("abcdef");
    expect(tailText("abcdef", 2)).toBe("[first 4 bytes omitted]\nef");
  });
});
