import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { FIXTURE_FILE, FixtureError, loadFixture, parseFixture } from "../src/index.ts";

const fixtureText = readFileSync(FIXTURE_FILE, "utf8");
const fixture = loadFixture();

function edited(edit: (data: Record<string, unknown>) => void): string {
  const data = JSON.parse(fixtureText) as Record<string, unknown>;
  edit(data);
  return `${JSON.stringify(sorted(data), null, 2)}\n`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

describe("fixture data file", () => {
  it("has the SHA-256 the README states", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const sha256 = createHash("sha256").update(fixtureText).digest("hex");
    expect(readme).toContain(`\`data/rc-1-backup-code-001.v1.json\` SHA-256: \`${sha256}\``);
  });

  it("identifies the fixture, the shape and the pinned host", () => {
    expect(fixture.fixture_id).toBe("rc-1-backup-code-001");
    expect(fixture.shape).toBe("RC-1");
    expect(fixture.host).toEqual({ upstream: "umami", commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae" });
  });

  it("names the one-line mutation: the used: false guard dropped from the verify route's updateMany", () => {
    expect(fixture.target.path).toBe("src/app/api/2fa/verify/route.ts");
    expect(fixture.target.clean_line.replace(", used: false", "")).toBe(fixture.target.planted_line);
    expect(fixture.target.clean_line).toContain("used: false");
  });

  it("bakes ten synthetic backup codes, each stored as a bcrypt hash at 10 rounds of its plaintext", () => {
    expect(fixture.two_factor.backup_codes).toHaveLength(10);
    for (const code of fixture.two_factor.backup_codes) {
      expect(code.plaintext).toMatch(/^SYNTHETIC-RC1-CODE-\d{2}$/);
      expect(code.code_hash.startsWith("$2b$10$")).toBe(true);
      expect(bcrypt.compareSync(code.plaintext, code.code_hash)).toBe(true);
    }
    const [first, second] = fixture.two_factor.backup_codes;
    expect(bcrypt.compareSync(first?.plaintext ?? "", second?.code_hash ?? "")).toBe(false);
  });

  it("enables two-factor sign-in for the pinned migration's admin user", () => {
    expect(fixture.two_factor.user_id).toBe("41e2b680-648e-4b09-bcd7-3e2b10c06264");
  });

  it("runs the serial control first, then the race on the last stored code, so the matching loop compares every code", () => {
    expect(fixture.checks.map((check) => [check.check_id, check.kind])).toEqual([
      ["rc1.backup-code-serial-reuse", "serial_reuse"],
      ["rc1.backup-code-concurrent-double-spend", "concurrent_double_spend"],
    ]);
    expect(fixture.checks[1]?.backup_code_id).toBe(fixture.two_factor.backup_codes.at(-1)?.id);
    expect(fixture.checks[0]?.backup_code_id).not.toBe(fixture.checks[1]?.backup_code_id);
  });

  it("declares the outcome vectors: both pass on clean and fixed, only the race fails on planted", () => {
    const pass = { observed: "pass", failure_code: null };
    expect(fixture.outcome_vectors.clean.map(({ observed, failure_code }) => ({ observed, failure_code }))).toEqual([pass, pass]);
    expect(fixture.outcome_vectors.fixed).toEqual(fixture.outcome_vectors.clean);
    expect(fixture.outcome_vectors.planted).toEqual([
      { check_id: "rc1.backup-code-serial-reuse", ...pass },
      { check_id: "rc1.backup-code-concurrent-double-spend", observed: "assertion_fail", failure_code: "double_spend" },
    ]);
  });

  it("declares the ADM-05 vectors for 20 repetitions in fixed-01 and planted-01", () => {
    expect(fixture.adm05.repetitions).toBe(20);
    expect(fixture.adm05.trials["fixed-01"]).toEqual(fixture.outcome_vectors.fixed);
    expect(fixture.adm05.trials["planted-01"]).toEqual(fixture.outcome_vectors.planted);
  });

  it("records ADM-06 as not applicable, with the reason", () => {
    expect(fixture.adm06.status).toBe("not_applicable");
    expect(fixture.adm06.reason).toContain("Oct 13, 2026");
    expect(Object.keys(fixture.outcome_vectors)).toEqual(["clean", "fixed", "planted"]);
  });
});

describe("parseFixture rejects", () => {
  it.each([
    ["non-canonical bytes", fixtureText.replace("\n", "\n ")],
    ["a partial-fix vector", edited((data) => (record(data.outcome_vectors).partial = record(data.outcome_vectors).clean))],
    ["a planted vector where the control fails", edited((data) => {
      const control = rows(record(data.outcome_vectors).planted)[0];
      if (control !== undefined) Object.assign(control, { observed: "assertion_fail", failure_code: "backup_code_reused" });
    })],
    ["an ADM-05 vector that differs from the planted vector", edited((data) => {
      const race = rows(record(record(data.adm05).trials)["planted-01"])[1];
      if (race !== undefined) Object.assign(race, { observed: "pass", failure_code: null });
    })],
    ["a pass with a failure code", edited((data) => {
      const row = rows(record(data.outcome_vectors).clean)[1];
      if (row !== undefined) row.failure_code = "double_spend";
    })],
    ["an unknown failure code", edited((data) => {
      const row = rows(record(data.outcome_vectors).planted)[1];
      if (row !== undefined) row.failure_code = "local_day_counts_mismatch";
    })],
    ["two checks spending the same code", edited((data) => {
      const [serial, race] = rows(data.checks);
      if (serial !== undefined && race !== undefined) race.backup_code_id = serial.backup_code_id;
    })],
    ["checks in the other order", edited((data) => (data.checks = rows(data.checks).reverse()))],
    ["a check spending an unknown code", edited((data) => {
      const race = rows(data.checks)[1];
      if (race !== undefined) race.backup_code_id = "synthetic-rc1-code-99";
    })],
    ["a code hash that is not bcrypt at 10 rounds", edited((data) => {
      const code = rows(record(data.two_factor).backup_codes)[0];
      if (code !== undefined) code.code_hash = String(code.code_hash).replace("$10$", "$12$");
    })],
    ["a plaintext that is not marked synthetic", edited((data) => {
      const code = rows(record(data.two_factor).backup_codes)[0];
      if (code !== undefined) code.plaintext = "ABCD-1234";
    })],
    ["nine codes", edited((data) => (record(data.two_factor).backup_codes = rows(record(data.two_factor).backup_codes).slice(1)))],
    ["an ADM-06 status other than not_applicable", edited((data) => (record(data.adm06).status = "implemented"))],
    ["another shape", edited((data) => (data.shape = "RC-2"))],
  ])("%s", (_name, text) => {
    expect(() => parseFixture(text)).toThrow(FixtureError);
  });
});
