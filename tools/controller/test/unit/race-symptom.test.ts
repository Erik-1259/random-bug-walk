// The race family's symptom, built from a synthetic observe job directory: an evidence.json whose
// added observations name recorded responses under records/, written here in the form the
// fixture's checks write them (src/race.ts encodeEvidence). Every time and outcome is invented.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRecord } from "@rbw/schema";
import { INVALID_BACKUP_CODE, loadFixture } from "@rbw/umami-fixture-rc1";
import type { VerifyAttempt } from "@rbw/umami-fixture-rc1";
import { RACE_FAMILY, SymptomUnavailable, TIME_ZONE_FAMILY, buildRaceSymptom, buildSymptom } from "../../src/symptom.ts";

const fixture = loadFixture();
const SERIAL = fixture.checks.find((check) => check.kind === "serial_reuse")?.check_id ?? "";
const RACE = fixture.checks.find((check) => check.kind === "concurrent_double_spend")?.check_id ?? "";
const prose = { user_action: "Entered the same unused backup code in two tabs at once.", locale: "en-US", fixture_description: "Synthetic: one account with two-step sign-in.", doc_excerpts: [] };

const accepted = (sent: number, settled: number): VerifyAttempt => ({ sent_ms: sent, settled_ms: settled, status: 200, error_code: null, token_issued: true, failure: null });
const refused = (sent: number, settled: number): VerifyAttempt => ({ sent_ms: sent, settled_ms: settled, status: 400, error_code: INVALID_BACKUP_CODE, token_issued: false, failure: null });

interface Round {
  repeat: number;
  race: { attempts: VerifyAttempt[]; overlap_ms: number; failure_code: string | null } | null;
  serial: { attempts: VerifyAttempt[]; observed: string } | null;
}

const DOUBLE: Round["race"] = { attempts: [accepted(0.012, 87.4), accepted(0.731, 91.6)], overlap_ms: 86.669, failure_code: "double_spend" };
const CONTROL: Round["serial"] = { attempts: [accepted(0, 63.8), refused(130.2, 170.9)], observed: "pass" };

/** Writes an observe job directory with one trial holding the rounds, and returns its path. */
function observeDir(rounds: Round[], options: { skipFile?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "race-symptom-"));
  const observations = [];
  for (const round of rounds) {
    const write = (checkId: string, body: unknown): string => {
      const key = `results/planted-01/${String(round.repeat)}/responses/${checkId}.json`;
      if (key !== options.skipFile) {
        mkdirSync(join(dir, "records", "results", "planted-01", String(round.repeat), "responses"), { recursive: true });
        writeFileSync(join(dir, "records", ...key.split("/")), `${JSON.stringify(body, null, 2)}\n`);
      }
      return key;
    };
    if (round.serial !== null) {
      const key = write(SERIAL, { check_id: SERIAL, kind: "serial_reuse", attempts: round.serial.attempts });
      observations.push({ check_id: SERIAL, repeat_index: round.repeat, observed: round.serial.observed, failure_code: round.serial.observed === "pass" ? null : "backup_code_reused", response_artifact_key: key });
    }
    if (round.race !== null) {
      const key = write(RACE, { check_id: RACE, kind: "concurrent_double_spend", attempts: round.race.attempts, overlap_ms: round.race.overlap_ms });
      observations.push({ check_id: RACE, repeat_index: round.repeat, observed: round.race.failure_code === null ? "pass" : "assertion_fail", failure_code: round.race.failure_code, response_artifact_key: key });
    }
  }
  writeFileSync(join(dir, "evidence.json"), JSON.stringify({ trials: [{ trial_id: "planted-01", added: { verdict: "failed", observations } }] }));
  return dir;
}

describe("the race symptom", () => {
  it("is a valid RaceSymptom: the two concurrent requests in whole milliseconds, one acceptance expected against two observed, and the passing control", () => {
    const symptom = buildRaceSymptom(observeDir([{ repeat: 1, race: DOUBLE, serial: CONTROL }]), prose);
    expect(assertRecord("RaceSymptom", symptom)).toBe(symptom);
    expect(symptom).toMatchObject({ symptom_kind: "concurrent_double_acceptance", request: { method: "POST", path: "/api/2fa/verify", query: {} }, ...prose });
    expect(symptom.concurrent_attempts).toEqual([
      { label: "request a", sent_ms: 0, settled_ms: 87, http_status: 200, outcome: "accepted", error_code: null },
      { label: "request b", sent_ms: 1, settled_ms: 92, http_status: 200, outcome: "accepted", error_code: null },
    ]);
    expect(symptom.overlap_ms).toBe(86);
    expect(symptom.expected).toEqual({ accepted: 1, refused: 1 });
    expect(symptom.observed).toEqual({ accepted: 2, refused: 0 });
    expect(symptom.sequential_attempts).toEqual([
      { label: "first use", sent_ms: 0, settled_ms: 64, http_status: 200, outcome: "accepted", error_code: null },
      { label: "reuse after the first use finished", sent_ms: 130, settled_ms: 171, http_status: 400, outcome: "refused", error_code: INVALID_BACKUP_CODE },
    ]);
  });

  it("names no backup code, check ID or token", () => {
    const text = JSON.stringify(buildRaceSymptom(observeDir([{ repeat: 1, race: DOUBLE, serial: CONTROL }]), prose));
    for (const code of fixture.two_factor.backup_codes) expect(text).not.toContain(code.plaintext);
    expect(text).not.toContain(SERIAL);
    expect(text).not.toContain(RACE);
    expect(text).not.toMatch(/token/i);
  });

  it("is what buildSymptom returns for the race family, while the time-zone family still reads its own fixture", () => {
    const dir = observeDir([{ repeat: 1, race: DOUBLE, serial: CONTROL }]);
    expect(buildSymptom(dir, prose, RACE_FAMILY)).toEqual(buildRaceSymptom(dir, prose));
    // The race recordings hold no time-zone observation, so the time-zone builder refuses them.
    expect(() => buildSymptom(dir, prose, TIME_ZONE_FAMILY)).toThrow(SymptomUnavailable);
  });

  it("takes the first round that graded double_spend, with that round's control", () => {
    const passing: Round["race"] = { attempts: [accepted(0, 50), refused(0.5, 60)], overlap_ms: 49.5, failure_code: null };
    const laterControl: Round["serial"] = { attempts: [accepted(0, 40), refused(80, 120)], observed: "pass" };
    const symptom = buildRaceSymptom(
      observeDir([
        { repeat: 1, race: passing, serial: CONTROL },
        { repeat: 2, race: DOUBLE, serial: laterControl },
      ]),
      prose,
    );
    expect(symptom.concurrent_attempts.map((item) => item.settled_ms)).toEqual([87, 92]);
    expect(symptom.sequential_attempts.map((item) => item.settled_ms)).toEqual([40, 120]);
  });

  const refusals: [string, Round[], { skipFile?: string }?][] = [
    ["no observation graded double_spend", [{ repeat: 1, race: { ...DOUBLE, failure_code: null }, serial: CONTROL }]],
    ["the concurrent recording is missing", [{ repeat: 1, race: DOUBLE, serial: CONTROL }], { skipFile: `results/planted-01/1/responses/${RACE}.json` }],
    ["the concurrent recording grades as one acceptance", [{ repeat: 1, race: { attempts: [accepted(0, 50), refused(0.5, 60)], overlap_ms: 49.5, failure_code: "double_spend" }, serial: CONTROL }]],
    ["the concurrent requests never overlapped", [{ repeat: 1, race: { attempts: [accepted(0, 40), accepted(41, 80)], overlap_ms: -1, failure_code: "double_spend" }, serial: CONTROL }]],
    ["the overlap is under a whole millisecond", [{ repeat: 1, race: { attempts: [accepted(0, 40.2), accepted(39.9, 80)], overlap_ms: 0.3, failure_code: "double_spend" }, serial: CONTROL }]],
    ["the round has no control", [{ repeat: 1, race: DOUBLE, serial: null }]],
    ["the control's recording is missing", [{ repeat: 1, race: DOUBLE, serial: CONTROL }], { skipFile: `results/planted-01/1/responses/${SERIAL}.json` }],
    ["the recorded control accepted the reuse", [{ repeat: 1, race: DOUBLE, serial: { attempts: [accepted(0, 40), accepted(80, 120)], observed: "pass" } }]],
    ["a recorded request failed without a response", [{ repeat: 1, race: { attempts: [accepted(0, 40), { ...accepted(1, 41), status: null, token_issued: false, failure: "synthetic reset" }], overlap_ms: 39, failure_code: "double_spend" }, serial: CONTROL }]],
  ];

  it.each(refusals)("refuses with symptom_unavailable when %s", (_name, rounds, options) => {
    const dir = observeDir(rounds, options);
    expect(() => buildRaceSymptom(dir, prose)).toThrow(SymptomUnavailable);
  });

  it("refuses a recording that is not a double-spend record", () => {
    const dir = observeDir([{ repeat: 1, race: DOUBLE, serial: CONTROL }]);
    writeFileSync(join(dir, "records", "results", "planted-01", "1", "responses", `${RACE}.json`), JSON.stringify({ pageviews: [] }));
    expect(() => buildRaceSymptom(dir, prose)).toThrow(/not a concurrent_double_spend record/);
  });

  it("refuses an observe job without evidence", () => {
    expect(() => buildRaceSymptom(mkdtempSync(join(tmpdir(), "race-symptom-empty-")), prose)).toThrow(SymptomUnavailable);
  });
});
