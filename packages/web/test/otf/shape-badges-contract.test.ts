// The shape badge contract: constants, the badge copy and its formatter, the display order, and the
// request and answer validators against synthetic examples (invented shapes and sentences only).
import { describe, expect, it } from "vitest";
import { QUERY_MAX_CHARS, SHAPE_SUMMARY_MAX_CHARS, SHAPE_TITLE_MAX_CHARS } from "../../src/assist/limits.ts";
import { OTF_CLASSIFY_REFUSAL_KINDS, OTF_ERROR_CODES, OTF_ERROR_STATUS, OTF_OPEN_FAMILIES, PROVEN_CRITERION_IDS, type ProvenCriterionId } from "../../src/otf/contract.ts";
import { validateOtf } from "../../src/otf/schemas.ts";
import {
  OTF_CLASSIFY_SHAPES_PATH,
  OTF_SHAPE_BADGES_ERRORS,
  OTF_SHAPE_BADGES_FLAG,
  SHAPE_BADGE_COPY,
  SHAPE_BADGE_OUTCOMES,
  SHAPE_BADGES_MAX_SHAPES,
  SHAPE_BADGES_MIN_SHAPES,
  SHAPE_BADGES_QUERY_MAX_CHARS,
  SHAPE_BADGES_QUERY_MIN_CHARS,
  SHAPE_BADGES_SUMMARY_MAX_CHARS,
  SHAPE_BADGES_TITLE_MAX_CHARS,
  SHAPE_PROVEN_BY_HOST,
  SHAPE_REASON_MAX_CHARS,
  SHAPE_REASON_MIN_CHARS,
  SHAPE_REFUSAL_KINDS,
  TRANSLATED_FAILURE_MAX_CHARS,
  TRANSLATED_FAILURE_MIN_CHARS,
  fillShapeBadgeTemplate,
  isBuildableBadge,
  orderShapesByBadge,
  provenFamily,
  shapeBadgeText,
  type OtfShapeBadge,
  type OtfShapeBadges,
  type OtfShapeBadgesRequest,
} from "../../src/otf/shape-badges-contract.ts";
import { parseShapeBadges, parseShapeBadgesRequest, validateShapeBadges, validateShapeBadgesRequest } from "../../src/otf/shape-badges-schemas.ts";

const SHAPE = { title: "Two saves overwrite each other", summary: "Two people edit the same record at once and one change is silently lost." };
const request = (overrides: Partial<OtfShapeBadgesRequest> = {}): OtfShapeBadgesRequest => ({
  query: "lost updates under load",
  host_id: "task-report",
  shapes: [SHAPE, SHAPE, SHAPE],
  ...overrides,
});
const TRANSLATED = "A completed task is missing from the daily report after two updates.";

const proven = (index: number, id: ProvenCriterionId = "concurrency.lost-acknowledged-change"): OtfShapeBadge => ({
  index,
  outcome: "proven",
  proven_criterion_id: id,
  family: provenFamily(id),
  translated_failure: null,
  refusal_kind: null,
  reason: null,
});
const open = (index: number, translated: string | null = TRANSLATED): OtfShapeBadge => ({
  index,
  outcome: "open",
  proven_criterion_id: null,
  family: "data_handling",
  translated_failure: translated,
  refusal_kind: null,
  reason: null,
});
const refused = (index: number, reason = "It needs a sign-in flow the service does not have."): OtfShapeBadge => ({
  index,
  outcome: "refused",
  proven_criterion_id: null,
  family: null,
  translated_failure: null,
  refusal_kind: "out_of_scope",
  reason,
});
const answer = (badges: unknown[]): OtfShapeBadges => ({ badges: badges as OtfShapeBadge[], model: "nvidia/Nemotron-3.5-Super-VL" });
/** A task-report answer for three shapes with one badge replaced by a raw object. */
const withBadge = (badge: Record<string, unknown>): OtfShapeBadges => answer([badge, open(1), refused(2)]);
const errorsFor = (value: unknown, req: OtfShapeBadgesRequest = request()): string[] => validateShapeBadges(value, req);

describe("shape badge constants", () => {
  it("names the route, the flag and the error codes", () => {
    expect(OTF_CLASSIFY_SHAPES_PATH).toBe("/api/factory/otf/classify-shapes");
    expect(OTF_SHAPE_BADGES_FLAG).toBe("RBW_OTF_SHAPE_BADGES");
    expect(OTF_SHAPE_BADGES_ERRORS).toEqual(["signed_out", "invalid_request", "unavailable"]);
    for (const code of OTF_SHAPE_BADGES_ERRORS) expect(OTF_ERROR_CODES).toContain(code);
    expect(OTF_SHAPE_BADGES_ERRORS.map((code) => OTF_ERROR_STATUS[code])).toEqual([401, 400, 503]);
  });

  it("uses the interface limits, tied to the designer's own caps", () => {
    expect([SHAPE_BADGES_QUERY_MIN_CHARS, SHAPE_BADGES_QUERY_MAX_CHARS]).toEqual([1, 300]);
    expect([SHAPE_BADGES_TITLE_MAX_CHARS, SHAPE_BADGES_SUMMARY_MAX_CHARS]).toEqual([200, 1200]);
    expect([SHAPE_BADGES_QUERY_MAX_CHARS, SHAPE_BADGES_TITLE_MAX_CHARS, SHAPE_BADGES_SUMMARY_MAX_CHARS]).toEqual([QUERY_MAX_CHARS, SHAPE_TITLE_MAX_CHARS, SHAPE_SUMMARY_MAX_CHARS]);
    expect([SHAPE_BADGES_MIN_SHAPES, SHAPE_BADGES_MAX_SHAPES]).toEqual([1, 5]);
    expect([TRANSLATED_FAILURE_MIN_CHARS, TRANSLATED_FAILURE_MAX_CHARS]).toEqual([20, 200]);
    expect([SHAPE_REASON_MIN_CHARS, SHAPE_REASON_MAX_CHARS]).toEqual([1, 160]);
  });

  it("lists the outcomes and reuses the classify refusal kinds", () => {
    expect(SHAPE_BADGE_OUTCOMES).toEqual(["proven", "open", "refused"]);
    expect(SHAPE_REFUSAL_KINDS).toBe(OTF_CLASSIFY_REFUSAL_KINDS);
  });

  it("allows the two concurrency criteria on task-report and time-zone grouping on Umami", () => {
    expect(SHAPE_PROVEN_BY_HOST["task-report"]).toEqual(["concurrency.lost-acknowledged-change", "concurrency.stale-success-response"]);
    expect(SHAPE_PROVEN_BY_HOST.umami).toEqual(["date_time.time-zone-grouping"]);
    expect(Object.isFrozen(SHAPE_PROVEN_BY_HOST)).toBe(true);
  });

  it("derives each proven criterion's family from its id", () => {
    expect(PROVEN_CRITERION_IDS.map(provenFamily)).toEqual(["concurrency", "concurrency", "date_time"]);
    for (const id of PROVEN_CRITERION_IDS) expect(OTF_OPEN_FAMILIES).toContain(provenFamily(id));
  });
});

describe("the request validator", () => {
  it("accepts a request and parses it", () => {
    expect(validateShapeBadgesRequest(request())).toEqual([]);
    expect(validateShapeBadgesRequest(request({ host_id: "umami", shapes: [SHAPE] }))).toEqual([]);
    expect(parseShapeBadgesRequest(request())).toEqual({ ok: true, value: request() });
    const parsed = parseShapeBadgesRequest({});
    expect(parsed.ok).toBe(false);
  });

  it("bounds the query in code points", () => {
    expect(validateShapeBadgesRequest(request({ query: "" }))).not.toEqual([]);
    expect(validateShapeBadgesRequest(request({ query: "q" }))).toEqual([]);
    expect(validateShapeBadgesRequest(request({ query: "q".repeat(300) }))).toEqual([]);
    expect(validateShapeBadgesRequest(request({ query: "q".repeat(301) }))).not.toEqual([]);
    // 300 astral characters are 600 UTF-16 code units but 300 code points.
    expect(validateShapeBadgesRequest(request({ query: "😀".repeat(300) }))).toEqual([]);
    expect(validateShapeBadgesRequest(request({ query: "😀".repeat(301) }))).not.toEqual([]);
  });

  it("takes only the two hosts", () => {
    expect(validateShapeBadgesRequest({ ...request(), host_id: "other" })).not.toEqual([]);
  });

  it("takes 1 to 5 shapes", () => {
    expect(validateShapeBadgesRequest(request({ shapes: [] }))).not.toEqual([]);
    expect(validateShapeBadgesRequest(request({ shapes: Array.from({ length: 5 }, () => SHAPE) }))).toEqual([]);
    expect(validateShapeBadgesRequest(request({ shapes: Array.from({ length: 6 }, () => SHAPE) }))).not.toEqual([]);
  });

  it("bounds each title and summary in code points", () => {
    const shape = (title: string, summary: string) => request({ shapes: [{ title, summary }] });
    expect(validateShapeBadgesRequest(shape("t".repeat(200), "s".repeat(1200)))).toEqual([]);
    expect(validateShapeBadgesRequest(shape("😀".repeat(200), "😀".repeat(1200)))).toEqual([]);
    expect(validateShapeBadgesRequest(shape("t".repeat(201), "s"))).not.toEqual([]);
    expect(validateShapeBadgesRequest(shape("t", "s".repeat(1201)))).not.toEqual([]);
    expect(validateShapeBadgesRequest(shape("", "s"))).not.toEqual([]);
    expect(validateShapeBadgesRequest(shape("t", ""))).not.toEqual([]);
  });

  it("refuses unknown and missing members", () => {
    expect(validateShapeBadgesRequest({ ...request(), extra: 1 })).not.toEqual([]);
    expect(validateShapeBadgesRequest(request({ shapes: [{ ...SHAPE, sources: [] } as never] }))).not.toEqual([]);
    expect(validateShapeBadgesRequest({ query: "q", host_id: "umami" })).not.toEqual([]);
    expect(validateShapeBadgesRequest(request({ shapes: [{ title: "t" } as never] }))).not.toEqual([]);
    expect(validateShapeBadgesRequest(null)).not.toEqual([]);
  });
});

describe("the answer validator", () => {
  it("accepts one badge per shape in any order, and parses it", () => {
    const value = answer([refused(2), proven(0), open(1)]);
    expect(errorsFor(value)).toEqual([]);
    expect(parseShapeBadges(value, request())).toEqual({ ok: true, value });
    expect(errorsFor(answer([proven(0, "concurrency.stale-success-response"), open(1, null), { ...refused(2), refusal_kind: "security" }]))).toEqual([]);
  });

  it("needs every index exactly once", () => {
    expect(errorsFor(answer([proven(0), open(0), refused(2)]))).not.toEqual([]);
    expect(errorsFor(answer([proven(0), open(1)]))).not.toEqual([]);
    expect(errorsFor(answer([proven(0), open(1), refused(2), refused(2)]))).not.toEqual([]);
    expect(errorsFor(answer([proven(0), open(1), refused(3)]))).not.toEqual([]);
    expect(errorsFor(answer([proven(-1), open(1), refused(2)]))).not.toEqual([]);
    expect(errorsFor(answer([{ ...proven(0), index: 0.5 }, open(1), refused(2)]))).not.toEqual([]);
    expect(errorsFor(answer([open(0)]), request({ shapes: [SHAPE] }))).toEqual([]);
    expect(errorsFor(answer([open(0), open(1)]), request({ shapes: [SHAPE] }))).not.toEqual([]);
  });

  it("checks the answer against its request's shape count and host", () => {
    const five = answer([0, 1, 2, 3, 4].map((i) => open(i)));
    expect(errorsFor(five, request({ shapes: Array.from({ length: 5 }, () => SHAPE) }))).toEqual([]);
    expect(errorsFor(five)).not.toEqual([]);
    expect(validateShapeBadges(five, { host_id: "task-report", shapes: [] })).toEqual(["/ no shape badge schema for host task-report with 0 shapes"]);
    expect(validateShapeBadges(five, { host_id: "task-report", shapes: Array.from({ length: 6 }, () => SHAPE) })).not.toEqual([]);
    expect(validateShapeBadges(five, { host_id: "other" as never, shapes: [SHAPE] })).not.toEqual([]);
  });

  it("allows only time-zone grouping as proven on an Umami search", () => {
    const umami = request({ host_id: "umami" });
    expect(errorsFor(answer([proven(0, "date_time.time-zone-grouping"), open(1), refused(2)]), umami)).toEqual([]);
    expect(errorsFor(answer([proven(0, "concurrency.lost-acknowledged-change"), open(1), refused(2)]), umami)).not.toEqual([]);
    expect(errorsFor(answer([proven(0, "concurrency.stale-success-response"), open(1), refused(2)]), umami)).not.toEqual([]);
  });

  it("allows only the concurrency criteria as proven on a task-report search", () => {
    expect(errorsFor(answer([proven(0, "date_time.time-zone-grouping"), open(1), refused(2)]))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), proven_criterion_id: "open.task-report-behavior" }))).not.toEqual([]);
  });

  it("ties every member to the outcome", () => {
    // proven: a criterion and its own family, nothing else.
    expect(errorsFor(withBadge({ ...proven(0), proven_criterion_id: null }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), family: "data_handling" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), family: null }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), translated_failure: TRANSLATED }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), refusal_kind: "security" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...proven(0), reason: "No." }))).not.toEqual([]);
    // open: a family, an optional sentence, nothing else.
    expect(errorsFor(withBadge({ ...open(0), proven_criterion_id: "concurrency.lost-acknowledged-change" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...open(0), family: null }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...open(0), family: "network" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...open(0), refusal_kind: "out_of_scope" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...open(0), reason: "No." }))).not.toEqual([]);
    for (const family of OTF_OPEN_FAMILIES) expect(errorsFor(withBadge({ ...open(0), family }))).toEqual([]);
    // refused: a kind and a reason, nothing else.
    expect(errorsFor(withBadge({ ...refused(0), refusal_kind: null }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), refusal_kind: "other" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), reason: null }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), family: "state_ui" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), proven_criterion_id: "concurrency.lost-acknowledged-change" }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), translated_failure: TRANSLATED }))).not.toEqual([]);
    expect(errorsFor(withBadge({ ...refused(0), outcome: "maybe" }))).not.toEqual([]);
  });

  it("needs every member present and refuses unknown ones", () => {
    for (const key of ["index", "outcome", "proven_criterion_id", "family", "translated_failure", "refusal_kind", "reason"]) {
      const badge = Object.fromEntries(Object.entries(open(0)).filter(([member]) => member !== key));
      expect(errorsFor(withBadge(badge)), key).not.toEqual([]);
    }
    expect(errorsFor(withBadge({ ...open(0), confidence: 0.9 }))).not.toEqual([]);
    expect(errorsFor({ ...answer([proven(0), open(1), refused(2)]), extra: true })).not.toEqual([]);
    expect(errorsFor({ badges: [proven(0), open(1), refused(2)] })).not.toEqual([]);
    expect(errorsFor({ ...answer([proven(0), open(1), refused(2)]), model: "" })).not.toEqual([]);
    expect(errorsFor({ ...answer([proven(0), open(1), refused(2)]), model: "has space" })).not.toEqual([]);
  });

  it("bounds translated_failure and reason in code points", () => {
    const sized = (n: number, unit = "a") => unit.repeat(n);
    expect(errorsFor(withBadge(open(0, sized(19))))).not.toEqual([]);
    expect(errorsFor(withBadge(open(0, sized(20))))).toEqual([]);
    expect(errorsFor(withBadge(open(0, sized(200))))).toEqual([]);
    expect(errorsFor(withBadge(open(0, sized(201))))).not.toEqual([]);
    expect(errorsFor(withBadge(open(0, sized(200, "😀"))))).toEqual([]);
    expect(errorsFor(withBadge(open(0, sized(201, "😀"))))).not.toEqual([]);
    expect(errorsFor(withBadge(open(0, "")))).not.toEqual([]);
    expect(errorsFor(withBadge(refused(0, "")))).not.toEqual([]);
    expect(errorsFor(withBadge(refused(0, "x")))).toEqual([]);
    expect(errorsFor(withBadge(refused(0, sized(160))))).toEqual([]);
    expect(errorsFor(withBadge(refused(0, sized(160, "😀"))))).toEqual([]);
    expect(errorsFor(withBadge(refused(0, sized(161))))).not.toEqual([]);
  });

  // The characters plain text refuses, and some it keeps, checked against OtfOpenRule.observable_failure
  // in schemas.ts so the two rules cannot drift apart.
  const REFUSED_CHARS = ["\t", "\n", "\r", "\u0000", "\u007f", "\u0085", " ", " ", "​", "‍", "‮", "﻿", "­"];
  const KEPT_CHARS = [" ", "é", "“", "”", "’", "😀", " ", "—"];
  const hex = (char: string): string => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  it.each([...REFUSED_CHARS.map((char) => [hex(char), char, false] as const), ...KEPT_CHARS.map((char) => [hex(char), char, true] as const)])(
    "treats U+%s as plain text exactly as observable_failure does",
    (_hex, char, kept) => {
      const translated = `The daily report${char} skips a completed task.`;
      const reason = `Out of scope${char} here.`;
      const ruleErrors = validateOtf("OtfOpenRule", { family: "data_handling", observable_failure: `${translated} ${"x".repeat(40)}`, failure_code: "report_skips_task" });
      expect(ruleErrors.length === 0).toBe(kept);
      expect(errorsFor(withBadge(open(0, translated))).length === 0).toBe(kept);
      expect(errorsFor(withBadge(refused(0, reason))).length === 0).toBe(kept);
    },
  );

  it("does not apply plain text to the request", () => {
    expect(validateShapeBadgesRequest(request({ shapes: [{ title: "Two saves", summary: "First line.\nSecond line." }] }))).toEqual([]);
  });
});

describe("badge copy", () => {
  it("holds the exact strings", () => {
    expect(SHAPE_BADGE_COPY).toEqual({
      loading: "Checking what can be built…",
      proven_umami: "Builds in Umami as a proven behavior: {label}",
      proven_task_report: "Builds as a proven behavior: {label}",
      open_task_report: "Builds in the task-report service",
      open_umami: "Builds in the task-report service, not Umami",
      open_detail: "Builds in the task-report service as: “{translated_failure}”. Not measured yet.",
      open_umami_fallback_detail:
        "The same kind of failure is recreated in our task-report service, because Umami builds cover time-zone grouping only. Not measured yet.",
      refused: "Can't be built here: {reason}",
      disagreement: "This card did not come out as its shape suggested. Other shapes from this search that can be built:",
    });
    expect(Object.isFrozen(SHAPE_BADGE_COPY)).toBe(true);
  });

  it("fills placeholders literally and refuses a missing value", () => {
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.proven_task_report, { label: "Lost change" })).toBe("Builds as a proven behavior: Lost change");
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.refused, { reason: "Costs $& and $1." })).toBe("Can't be built here: Costs $& and $1.");
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.open_detail, { translated_failure: "A saved title comes back empty." })).toBe(
      "Builds in the task-report service as: “A saved title comes back empty”. Not measured yet.",
    );
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.open_detail, { translated_failure: "Counts drop!?" })).toBe(
      "Builds in the task-report service as: “Counts drop”. Not measured yet.",
    );
    expect(fillShapeBadgeTemplate("Can't be built here: {reason}", { reason: "Out of scope." })).toBe("Can't be built here: Out of scope.");
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.open_detail, { translated_failure: "{label} stays" })).toBe(
      "Builds in the task-report service as: “{label} stays”. Not measured yet.",
    );
    expect(fillShapeBadgeTemplate(SHAPE_BADGE_COPY.loading, {})).toBe("Checking what can be built…");
    expect(() => fillShapeBadgeTemplate(SHAPE_BADGE_COPY.refused, { label: "x" })).toThrow(/reason/);
  });

  const LABELS = { "concurrency.lost-acknowledged-change": "Lost acknowledged change", "date_time.time-zone-grouping": "Time-zone grouping" } as const;

  it("words a proven badge per host, and answers null without its label", () => {
    expect(shapeBadgeText(proven(0), "task-report", LABELS)).toEqual({ headline: "Builds as a proven behavior: Lost acknowledged change", detail: null });
    expect(shapeBadgeText(proven(0, "date_time.time-zone-grouping"), "umami", LABELS)).toEqual({
      headline: "Builds in Umami as a proven behavior: Time-zone grouping",
      detail: null,
    });
    expect(shapeBadgeText(proven(0, "concurrency.stale-success-response"), "task-report", LABELS)).toBeNull();
  });

  it("words an open badge per host, with the Umami fallback when the sentence is missing", () => {
    const detail = `Builds in the task-report service as: “${TRANSLATED.replace(/[.!?]+$/u, "")}”. Not measured yet.`;
    expect(shapeBadgeText(open(0), "task-report", LABELS)).toEqual({ headline: "Builds in the task-report service", detail });
    expect(shapeBadgeText(open(0), "umami", LABELS)).toEqual({ headline: "Builds in the task-report service, not Umami", detail });
    expect(shapeBadgeText(open(0, null), "umami", LABELS)).toEqual({ headline: "Builds in the task-report service, not Umami", detail: SHAPE_BADGE_COPY.open_umami_fallback_detail });
    expect(shapeBadgeText(open(0, null), "task-report", LABELS)).toEqual({ headline: "Builds in the task-report service", detail: null });
  });

  it("words a refused badge with its reason", () => {
    expect(shapeBadgeText(refused(0, "It is about passwords."), "umami", LABELS)).toEqual({ headline: "Can't be built here: It is about passwords.", detail: null });
  });
});

describe("display order", () => {
  const names = ["a", "b", "c", "d", "e"];

  it("puts proven first, then open, then refused, keeping the designer's order within each", () => {
    const badges = [refused(0), open(1), proven(2), refused(3), proven(4)];
    const ordered = orderShapesByBadge(names, badges);
    expect(ordered.map((item) => item.shape)).toEqual(["c", "e", "b", "a", "d"]);
    expect(ordered.map((item) => item.index)).toEqual([2, 4, 1, 0, 3]);
    expect(ordered[0]?.badge).toEqual(proven(2));
  });

  it("is stable when every badge has the same outcome", () => {
    expect(orderShapesByBadge(names, [4, 3, 2, 1, 0].map((i) => open(i))).map((item) => item.shape)).toEqual(names);
  });

  it("keeps the designer's order without badges", () => {
    expect(orderShapesByBadge(names, null)).toEqual(names.map((shape, index) => ({ shape, index, badge: null })));
  });

  it("puts a shape without a badge after the buildable ones and before the refused ones", () => {
    expect(orderShapesByBadge(["a", "b", "c"], [refused(0), open(2)]).map((item) => item.shape)).toEqual(["c", "b", "a"]);
  });

  it("does not change its input", () => {
    const input = ["a", "b"];
    orderShapesByBadge(input, [refused(0), proven(1)]);
    expect(input).toEqual(["a", "b"]);
  });

  it("tells buildable badges apart", () => {
    expect([proven(0), open(0), refused(0), null, undefined].map(isBuildableBadge)).toEqual([true, true, false, false, false]);
  });
});
