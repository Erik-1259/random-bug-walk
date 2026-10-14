import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseError, checkCaseForMode, controllerBase, parseCase, screenStatus } from "../src/case.ts";
import { PILOT_SCREEN_RECORD } from "../src/fakes.ts";
import { ABBA_BLOCK, MAIN_ATTEMPTS, PILOT_LABEL, SPEND_CAPS_MICROUSD, attemptPlan } from "../src/plan.ts";

/** A race screen record with every field the pre-registration lists, both verdicts pass. */
const SCREEN = {
  schema_version: 1,
  case_id: "umami-race-001",
  recorded: "2026-10-14",
  recorded_by: "race-class screen",
  target: { upstream: "umami", host_commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae", path: "src/app/api/send/route.ts", sha256: "a".repeat(64), mutation: "packages/shapes/probes/rc-x/mutation.patch" },
  static_headroom: { verdict: "pass", judgment: "The omission is not plain from the pre-fix source alone.", reasons: ["No in-file twin."] },
  leak_screen: { verdict: "pass", issue_text: "No error text.", observe_and_writer_evidence: "No error text.", http_responses: "HTTP 500 with no body.", server_logs: "The Postgres error." },
  uc1_use: "UC1 subject",
};

function fullScreen(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SCREEN, ...change };
}

describe("the pre-registered plan", () => {
  it("orders the 40 attempts in ABBA blocks, ten times, with 20 per arm", () => {
    const plan = attemptPlan("run");
    expect(plan).toHaveLength(MAIN_ATTEMPTS);
    expect(plan.map((item) => item.index)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(plan.slice(0, 8).map((item) => item.arm)).toEqual(["off", "on", "on", "off", "off", "on", "on", "off"]);
    for (let block = 0; block < 10; block += 1) expect(plan.slice(block * 4, block * 4 + 4).map((item) => item.arm)).toEqual([...ABBA_BLOCK]);
    expect(plan.filter((item) => item.arm === "off")).toHaveLength(20);
  });

  it("gives every attempt index its own seed, so no two attempts share one within or across arms", () => {
    const plan = attemptPlan("run");
    expect(new Set(plan.map((item) => item.seed)).size).toBe(40);
    expect(plan.every((item) => item.seed === item.index)).toBe(true);
  });

  it("runs the pilot as 2 off and 2 on attempts in one ABBA block", () => {
    expect(attemptPlan("pilot").map((item) => [item.index, item.arm, item.seed])).toEqual([
      [1, "off", 1],
      [2, "on", 2],
      [3, "on", 3],
      [4, "off", 4],
    ]);
    // The Kimi fallback gets 2 pilot attempts, one per arm; a counted run is 40 on either model.
    expect(attemptPlan("pilot", "kimi").map((item) => item.arm)).toEqual(["off", "on"]);
    expect(attemptPlan("run", "kimi")).toHaveLength(40);
    expect(PILOT_LABEL).toBe("harness pilot; bug fails the static-headroom screen; not a UC1 result");
  });

  it("caps UC1 spend at $40 on Super and $75 on the Kimi fallback", () => {
    expect(SPEND_CAPS_MICROUSD).toEqual({ super: 40_000_000n, kimi: 75_000_000n });
  });
});

describe("case files and screen records", () => {
  const caseJson = {
    case_id: "umami-tz-arg-001",
    family: "time-zone",
    screen_record: "docs/uc1-screen/umami-tz-arg-001.json",
    issue: "issue.txt",
    image: "rbw-umami-kit:local",
    image_digest: `sha256:${"f9".repeat(32)}`,
    sandbox_image: `registry.example/kit@sha256:${"ab".repeat(32)}`,
    manifest: "m.json",
    terms: "t.txt",
    audit_policy: null,
    probes_dir: null,
    reference_fix: "tools/local-runner/probes",
    kit_stage: "stage",
    original_suite: null,
  };

  it("parses a case file, resolving its paths, and refuses unknown or missing fields", () => {
    const config = parseCase(Buffer.from(JSON.stringify(caseJson)));
    expect(config.case_id).toBe("umami-tz-arg-001");
    expect(config.manifest.startsWith("/")).toBe(true);
    expect(config.audit_policy).toBeNull();
    expect(() => parseCase(Buffer.from(JSON.stringify({ ...caseJson, extra: 1 })))).toThrow("unknown fields: extra");
    const missing: Record<string, unknown> = { ...caseJson };
    delete missing.terms;
    expect(() => parseCase(Buffer.from(JSON.stringify(missing)))).toThrow("terms");
    expect(() => parseCase(Buffer.from(JSON.stringify({ ...caseJson, image_digest: "rbw:latest" })))).toThrow("image_digest");
    expect(() => parseCase(Buffer.from(JSON.stringify({ ...caseJson, sandbox_image: "registry.example/kit:latest" })))).toThrow("pinned by digest");
  });

  it("passes the case's controller options to both grades", () => {
    const config = parseCase(Buffer.from(JSON.stringify({ ...caseJson, original_suite: "suite.json" })));
    const base = controllerBase(config);
    // The kit image by the case's content digest, never by its tag, so a retagged image cannot be graded.
    expect(base.slice(0, 2)).toEqual(["--image", `sha256:${"f9".repeat(32)}`]);
    expect(base).not.toContain("rbw-umami-kit:local");
    expect(base).toContain("--original-suite");
    expect(base).not.toContain("--policy");
    expect(base).not.toContain("--probes-dir");
  });

  it("passes the case's probe directory to both grades, so they grade the same probes the session planted", () => {
    const config = parseCase(Buffer.from(JSON.stringify({ ...caseJson, probes_dir: "packages/shapes/probes/rc-1" })));
    const base = controllerBase(config);
    expect(base[base.indexOf("--probes-dir") + 1]).toBe(config.probes_dir);
  });

  it("passes a race case's family to both grades with its probes, and refuses an unknown family", () => {
    const race = controllerBase(parseCase(Buffer.from(JSON.stringify({ ...caseJson, family: "race", probes_dir: "packages/shapes/probes/rc-1" }))));
    expect(race[race.indexOf("--family") + 1]).toBe("race");
    expect(controllerBase(parseCase(Buffer.from(JSON.stringify(caseJson))))).not.toContain("--family");
    expect(() => parseCase(Buffer.from(JSON.stringify({ ...caseJson, family: "sql" })))).toThrow("family");
    const missing: Record<string, unknown> = { ...caseJson };
    delete missing.family;
    expect(() => parseCase(Buffer.from(JSON.stringify(missing)))).toThrow("family");
  });

  it("reads the committed time-zone screen record as failing, so only the pilot may run it", () => {
    const status = screenStatus(readFileSync(PILOT_SCREEN_RECORD));
    expect(status).toMatchObject({ case_id: "umami-tz-arg-001", eligible: false });
    const config = parseCase(Buffer.from(JSON.stringify(caseJson)));
    expect(() => {
      checkCaseForMode("pilot", config, status);
    }).not.toThrow();
    expect(() => {
      checkCaseForMode("run", config, status);
    }).toThrow(CaseError);
    expect(() => {
      checkCaseForMode("run", config, status);
    }).toThrow("not eligible for a counted UC1 run");
  });

  it("admits a race case to a counted run only when both screen verdicts pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-screen-"));
    const record = (headroom: string, leak: string) => {
      const path = join(dir, `${headroom}-${leak}.json`);
      writeFileSync(path, JSON.stringify(fullScreen({ static_headroom: { ...SCREEN.static_headroom, verdict: headroom }, leak_screen: { ...SCREEN.leak_screen, verdict: leak } })));
      return screenStatus(readFileSync(path));
    };
    const config = parseCase(Buffer.from(JSON.stringify({ ...caseJson, case_id: "umami-race-001", family: "race" })));
    const check = (mode: "pilot" | "run", caseConfig: typeof config, screen: ReturnType<typeof record>) => () => {
      checkCaseForMode(mode, caseConfig, screen);
    };
    expect(check("run", config, record("pass", "pass"))).not.toThrow();
    expect(check("run", config, record("pass", "not_assessed"))).toThrow("leak screen not_assessed");
    expect(check("run", config, record("fail", "pass"))).toThrow("static headroom fail");
    expect(check("pilot", config, record("pass", "pass"))).toThrow("runs only umami-tz-arg-001");
    expect(check("run", parseCase(Buffer.from(JSON.stringify({ ...caseJson, case_id: "umami-race-002", family: "race" }))), record("pass", "pass"))).toThrow("is for umami-race-001");
  });

  it("refuses a counted run on a case whose family is not race, even with a passing screen record", () => {
    const screen = screenStatus(Buffer.from(JSON.stringify(fullScreen())));
    expect(screen.eligible).toBe(true);
    const timeZone = parseCase(Buffer.from(JSON.stringify({ ...caseJson, case_id: "umami-race-001", family: "time-zone" })));
    expect(() => {
      checkCaseForMode("run", timeZone, screen);
    }).toThrow("only a race-class case");
    const race = parseCase(Buffer.from(JSON.stringify({ ...caseJson, case_id: "umami-race-001", family: "race" })));
    expect(() => {
      checkCaseForMode("run", race, screen);
    }).not.toThrow();
  });

  it("finds a screen record ineligible unless every pre-registered field is present and well formed", () => {
    expect(screenStatus(Buffer.from(JSON.stringify(fullScreen()))).eligible).toBe(true);
    // Only the two verdicts and the identifiers: the judgment, target, reasons and evidence comparison are absent.
    const bare = { schema_version: 1, case_id: "umami-race-001", static_headroom: { verdict: "pass" }, leak_screen: { verdict: "pass" } };
    const status = screenStatus(Buffer.from(JSON.stringify(bare)));
    expect(status).toMatchObject({ case_id: "umami-race-001", eligible: false });
    expect(status.detail).toContain("recorded");
    const broken: [string, Record<string, unknown>][] = [
      ["recorded", { recorded: "Oct 13" }],
      ["recorded_by", { recorded_by: "" }],
      ["target", { target: {} }],
      ["target.sha256", { target: { ...SCREEN.target, sha256: "abc" } }],
      ["target.mutation", { target: { ...SCREEN.target, mutation: 1 } }],
      ["static_headroom.judgment", { static_headroom: { ...SCREEN.static_headroom, judgment: "" } }],
      ["static_headroom.reasons", { static_headroom: { ...SCREEN.static_headroom, reasons: [] } }],
      ["leak_screen.server_logs", { leak_screen: { verdict: "pass", issue_text: "x", observe_and_writer_evidence: "x", http_responses: "x" } }],
      ["uc1_use", { uc1_use: null }],
      ["schema_version", { schema_version: 2 }],
    ];
    for (const [field, change] of broken) {
      const result = screenStatus(Buffer.from(JSON.stringify(fullScreen(change))));
      expect(result.eligible, field).toBe(false);
      expect(result.detail, field).toContain(field);
    }
  });
});
