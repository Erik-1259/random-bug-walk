import { parsePatch } from "diff";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/json.ts";
import { RuleFileError } from "../../src/rules.ts";
import { DT1_TARGET, FIDELITY, SHAPE_ID } from "../../src/shape.ts";
import { confirmTarget, confirmTargetWith, type TargetOutcome } from "../../src/target.ts";
import {
  CLEAN_LINE,
  PLANTED_LINE,
  ROUTE,
  RULE,
  SYNTHETIC_COMMIT,
  SYNTHETIC_PATH,
  TARGET,
  broadRule,
  plant,
  sha256,
  targetInput,
  targetSpec,
} from "./support.ts";

function run(target: string, route = ROUTE, rule: Uint8Array = RULE): TargetOutcome {
  return confirmTargetWith(targetSpec(target, route), targetInput(target, route, rule));
}

function reason(outcome: TargetOutcome): string {
  expect(outcome.status).toBe("not_applicable");
  return outcome.status === "not_applicable" ? outcome.reason : "";
}

const CLICKHOUSE_LINES = TARGET.split("\n").filter((line) => line.includes("as t from website_event"));

describe("confirmTarget on a synthetic relationalQuery", () => {
  it("confirms the one call and drops only its third argument in a one-hunk diff", () => {
    const outcome = run(TARGET);
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    const { record } = outcome;
    expect(record.shape_id).toBe(SHAPE_ID);
    expect(record.fidelity).toEqual({ label: "synthetic_transplant", tier: "B" });
    expect(record.rule_sha256).toBe(sha256(RULE.toString("utf8")));
    expect(record.target.line).toBe(18);
    expect(record.target.mode).toBe("100644");
    expect(record.target.changed_calls).toBe(1);
    expect(record.target.function).toBe(`${SYNTHETIC_PATH}#relationalQuery`);
    expect(record.target.original_sha256).toBe(sha256(TARGET));
    expect(record.target.result_sha256).toBe(sha256(plant(TARGET)));
    expect(record.route.sha256).toBe(sha256(ROUTE));

    const patches = parsePatch(record.target.diff);
    expect(patches).toHaveLength(1);
    const hunks = patches[0]?.hunks ?? [];
    expect(hunks).toHaveLength(1);
    const changed = hunks[0]?.lines.filter((line) => line.startsWith("-") || line.startsWith("+"));
    expect(changed).toEqual([`-${CLEAN_LINE}`, `+${PLANTED_LINE}`]);
    expect(hunks[0]?.oldStart).toBe(15);
    expect(record.target.diff.startsWith(`diff --git a/${SYNTHETIC_PATH} b/${SYNTHETIC_PATH}\n`)).toBe(true);
    expect(record.target.diff).toContain(`\n--- a/${SYNTHETIC_PATH}\n+++ b/${SYNTHETIC_PATH}\n`);
  });

  it("writes the declared mutation with sorted keys and no insignificant whitespace", () => {
    const outcome = run(TARGET);
    if (outcome.status !== "confirmed") {
      throw new Error(`expected confirmed, got ${outcome.reason}`);
    }
    const diff = outcome.record.target.diff;
    expect(canonicalJson(outcome.declaredMutation)).toBe(
      `{"diff":${JSON.stringify(diff)},"files":[{"mode":"100644","original_sha256":"${sha256(TARGET)}",` +
        `"path":"${SYNTHETIC_PATH}","result_sha256":"${sha256(plant(TARGET))}"}],"host_commit":"${SYNTHETIC_COMMIT}"}`,
    );
  });

  it("leaves the two ClickHouse calls untouched", () => {
    const outcome = run(TARGET);
    if (outcome.status !== "confirmed") {
      throw new Error(`expected confirmed, got ${outcome.reason}`);
    }
    expect(CLICKHOUSE_LINES).toHaveLength(2);
    for (const line of CLICKHOUSE_LINES) {
      expect(outcome.result).toContain(line);
      expect(outcome.record.target.diff).not.toContain("as t from");
    }
    expect(outcome.result).toBe(plant(TARGET));
  });

  it("is not applicable when the file hash differs from the declared hash", () => {
    const spec = targetSpec(TARGET, ROUTE, { sha256: sha256(`${TARGET}\n`) });
    expect(reason(confirmTargetWith(spec, targetInput(TARGET)))).toBe("file_hash_mismatch");
  });

  it("keeps the expected file hash in the package, not in the caller's input", () => {
    expect(DT1_TARGET.sha256).toBe("1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b");
    expect(DT1_TARGET.resultSha256).toBe("7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c");
    const input = { ...targetInput(TARGET), path: DT1_TARGET.path };
    expect(reason(confirmTarget(input))).toBe("file_hash_mismatch");
  });

  it("is not applicable for a different path or mode", () => {
    const spec = targetSpec(TARGET);
    expect(reason(confirmTargetWith(spec, { ...targetInput(TARGET), path: "src/other.ts" }))).toBe("path_mismatch");
    expect(reason(confirmTargetWith(spec, { ...targetInput(TARGET), mode: "100755" }))).toBe("mode_mismatch");
  });

  it("is not applicable on a tree that already lacks the argument", () => {
    expect(reason(run(plant(TARGET)))).toBe("match_count");
  });

  it("is not applicable with two matching calls in relationalQuery", () => {
    const twice = TARGET.replace(CLEAN_LINE, `${CLEAN_LINE}\n${CLEAN_LINE.replace(" x,", " x2,")}`);
    const outcome = run(twice);
    expect(reason(outcome)).toBe("match_count");
    expect(outcome.status === "not_applicable" && outcome.detail).toContain("found 2");
  });

  it("is not applicable when timezone is bound from something other than filters", () => {
    const fromOptions = TARGET.replace(
      "  const { timezone = 'utc', unit = 'day' } = filters;",
      "  const options = { ...filters };\n  const { timezone = 'utc', unit = 'day' } = options;",
    );
    expect(reason(run(fromOptions))).toBe("binding_mismatch");

    const rebound = TARGET.replace(
      "  const { getDateSQL, rawQuery } = synthetic;\n\n  return rawQuery(\n",
      "  const { getDateSQL, rawQuery } = synthetic;\n  {\n    const timezone = 'UTC';\n  }\n\n  return rawQuery(\n",
    );
    expect(rebound).not.toBe(TARGET);
    expect(reason(run(rebound))).toBe("binding_mismatch");

    const reassigned = TARGET.replace(
      "  const { getDateSQL, rawQuery } = synthetic;\n\n  return rawQuery(\n",
      "  const { getDateSQL, rawQuery } = synthetic;\n  timezone = 'UTC';\n\n  return rawQuery(\n",
    );
    expect(reassigned).not.toBe(TARGET);
    expect(reason(run(reassigned))).toBe("binding_mismatch");

    const renamedParam = TARGET.replace(
      "async function relationalQuery(siteId: string, filters: SyntheticFilters) {\n  const { timezone = 'utc', unit = 'day' } = filters;",
      "async function relationalQuery(filters: SyntheticFilters, siteId: string) {\n  const { timezone = 'utc', unit = 'day' } = filters;",
    );
    expect(renamedParam).not.toBe(TARGET);
    expect(reason(run(renamedParam))).toBe("binding_mismatch");

    const renamedKey = TARGET.replace(
      "  const { timezone = 'utc', unit = 'day' } = filters;\n  const { getDateSQL, rawQuery } = synthetic;\n\n  return rawQuery(",
      "  const { tz: timezone = 'utc', unit = 'day' } = filters;\n  const { getDateSQL, rawQuery } = synthetic;\n\n  return rawQuery(",
    );
    expect(renamedKey).not.toBe(TARGET);
    expect(reason(run(renamedKey))).toBe("binding_mismatch");
  });

  it("is not applicable with a different first argument or a non-unit second argument", () => {
    const otherField = TARGET.replace(CLEAN_LINE, CLEAN_LINE.replace("website_event.created_at", "website_event.updated_at"));
    expect(reason(run(otherField))).toBe("match_count");
    const otherUnit = TARGET.replace(CLEAN_LINE, CLEAN_LINE.replace(", unit,", ", 'day',"));
    expect(reason(run(otherUnit))).toBe("match_count");
  });

  it("is not applicable when the endpoint does not pass filters", () => {
    const widened = ROUTE.replace(
      "getPageviewStats(websiteId, filters)",
      "getPageviewStats(websiteId, { ...filters, timezone: 'utc' })",
    );
    expect(widened).not.toBe(ROUTE);
    expect(reason(run(TARGET, widened))).toBe("endpoint_mismatch");

    const otherBuilder = ROUTE.replace("getQueryFilters(query, websiteId)", "getDefaultFilters(websiteId)");
    expect(otherBuilder).not.toBe(ROUTE);
    expect(reason(run(TARGET, otherBuilder))).toBe("endpoint_mismatch");

    const shadowed = ROUTE.replace(
      "  const pageviews = await getPageviewStats(websiteId, filters);",
      "  const pageviews = await (async (filters: object) => getPageviewStats(websiteId, filters))({});",
    );
    expect(shadowed).not.toBe(ROUTE);
    expect(reason(run(TARGET, shadowed))).toBe("endpoint_mismatch");
  });

  it("is not applicable when the route hash differs from the declared hash", () => {
    const spec = targetSpec(TARGET, ROUTE, { routeSha256: sha256("synthetic-other-route") });
    expect(reason(confirmTargetWith(spec, targetInput(TARGET)))).toBe("route_hash_mismatch");
  });

  it("is not applicable when the rewrite does not give the recorded result hash", () => {
    const spec = targetSpec(TARGET, ROUTE, { resultSha256: sha256("synthetic-other-result") });
    expect(reason(confirmTargetWith(spec, targetInput(TARGET)))).toBe("result_hash_mismatch");
  });

  it("applies the rewrite from the rule's fix template", () => {
    const changedFix = Buffer.from(
      RULE.toString("utf8").replace("fix: getDateSQL($FIELD, $UNIT)", "fix: getDateSQL($FIELD, $UNIT, 'UTC')"),
    );
    expect(reason(run(TARGET, ROUTE, changedFix))).toBe("fix_not_single_call");
  });

  it("is not applicable with a broad rule that selects the ClickHouse calls too", () => {
    const outcome = run(TARGET, ROUTE, broadRule());
    expect(reason(outcome)).toBe("match_count");
    expect(outcome.status === "not_applicable" && outcome.detail).toBe(
      "expected exactly one rule match, found 3 (lines 18, 33, 36)",
    );
  });

  it("throws on a malformed rule file", () => {
    expect(() => run(TARGET, ROUTE, Buffer.from("id: [unclosed"))).toThrow(RuleFileError);
  });

  it("gives identical record bytes for identical inputs", () => {
    const first = run(TARGET);
    const second = run(TARGET);
    expect(first.status).toBe("confirmed");
    if (first.status === "confirmed" && second.status === "confirmed") {
      expect(canonicalJson(first.record)).toBe(canonicalJson(second.record));
      expect(canonicalJson(first.declaredMutation)).toBe(canonicalJson(second.declaredMutation));
    }
  });

  it("labels the shape as a synthetic transplant at tier B", () => {
    expect(FIDELITY).toEqual({ label: "synthetic_transplant", tier: "B" });
  });
});
