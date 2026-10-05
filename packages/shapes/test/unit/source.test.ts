import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/json.ts";
import { DT1_SOURCE } from "../../src/shape.ts";
import { confirmSource, confirmSourceWith, type SourceOutcome } from "../../src/source.ts";
import { AFTER, BEFORE, SOURCE_COMMIT, SOURCE_PARENT, SOURCE_PATH, gitBlob, sha256, sourceInput, sourceSpec } from "./support.ts";

function run(before = BEFORE, after = AFTER): SourceOutcome {
  return confirmSourceWith(sourceSpec(before, after), sourceInput(before, after));
}

function reason(outcome: SourceOutcome): string {
  expect(outcome.status).toBe("unsupported_source_match");
  return outcome.status === "unsupported_source_match" ? outcome.reason : "";
}

describe("confirmSource on a synthetic date-range fix", () => {
  it("pairs the useDateRange call before and after the fix", () => {
    const outcome = run();
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    const { record } = outcome;
    expect(record.shape_id).toBe("DT-1.tz-arg");
    expect(record.fidelity).toEqual({ label: "synthetic_transplant", tier: "B" });
    expect(record.source.commit).toBe(SOURCE_COMMIT);
    expect(record.source.parent).toBe(SOURCE_PARENT);
    expect(record.source.function).toBe(`${SOURCE_PATH}#RevenuePage`);
    expect(record.source.callee).toBe("useDateRange");
    expect(record.source.added_argument).toBe("timezone");
    expect(record.source.before).toEqual({
      call: "useDateRange()",
      git_blob: gitBlob(BEFORE),
      line: 8,
      sha256: sha256(BEFORE),
    });
    expect(record.source.after).toEqual({
      binding: { line: 6, text: "const { timezone } = useTimezone();" },
      call: "useDateRange({ timezone })",
      git_blob: gitBlob(AFTER),
      line: 9,
      sha256: sha256(AFTER),
    });
    expect(record.source.hunk).toBe("@@ -1,11 +1,12 @@");
  });

  it("is unsupported when the after side does not bind timezone from useTimezone", () => {
    const after = AFTER.replace("const { timezone } = useTimezone();", "const timezone = 'UTC';");
    expect(after).not.toBe(AFTER);
    expect(reason(run(BEFORE, after))).toBe("binding_mismatch");

    const fromOther = AFTER.replace("const { timezone } = useTimezone();", "const { timezone } = useSyntheticZone();");
    expect(reason(run(BEFORE, fromOther))).toBe("binding_mismatch");
  });

  it("is unsupported when the after side passes something other than { timezone }", () => {
    const after = AFTER.replace("useDateRange({ timezone })", "useDateRange({ timezone: 'UTC' })");
    expect(after).not.toBe(AFTER);
    expect(reason(run(BEFORE, after))).toBe("after_form");
  });

  it("is unsupported when the before side already has an argument or a useTimezone call", () => {
    const withArgument = BEFORE.replace("useDateRange()", "useDateRange({ unit: 'day' })");
    expect(reason(run(withArgument, AFTER))).toBe("before_form");
    const withHook = BEFORE.replace("  const {\n", "  useTimezone();\n  const {\n");
    expect(withHook).not.toBe(BEFORE);
    expect(reason(run(withHook, AFTER))).toBe("before_form");
  });

  it("is unsupported with two useDateRange calls in the function", () => {
    const after = AFTER.replace("  return <Panel", "  const other = useDateRange();\n\n  return <Panel");
    expect(after).not.toBe(AFTER);
    const outcome = run(BEFORE, after);
    expect(reason(outcome)).toBe("call_count");
    expect(outcome.status === "unsupported_source_match" && outcome.detail).toMatch(/^after: .*found 2$/);
    const nested = AFTER.replace("  return <Panel", "  const later = () => useDateRange();\n\n  return <Panel");
    expect(nested).not.toBe(AFTER);
    expect(reason(run(BEFORE, nested))).toBe("call_count");
  });

  it("is unsupported when the call moved to another function", () => {
    const after = AFTER.replace("export function RevenuePage(", "export function SyntheticRevenuePage(");
    expect(reason(run(BEFORE, after))).toBe("function_missing");
    const moved = `${AFTER.replace("  } = useDateRange({ timezone });", "  } = useSyntheticRange();")}\nfunction Other() {\n  return useDateRange({ timezone: 'UTC' });\n}\n`;
    expect(reason(run(BEFORE, moved))).toBe("call_count");
  });

  it("is unsupported for a two-file commit", () => {
    const input = sourceInput(BEFORE, AFTER, {
      changes: [
        { status: "M", path: SOURCE_PATH },
        { status: "M", path: "src/synthetic/other.ts" },
      ],
    });
    expect(reason(confirmSourceWith(sourceSpec(), input))).toBe("changed_files");
  });

  it("is unsupported for a rename", () => {
    const input = sourceInput(BEFORE, AFTER, {
      changes: [{ status: "R097", path: SOURCE_PATH, oldPath: "src/synthetic/OldRevenuePage.tsx" }],
    });
    expect(reason(confirmSourceWith(sourceSpec(), input))).toBe("rename");
  });

  it("is unsupported for a different changed path", () => {
    const input = sourceInput(BEFORE, AFTER, { changes: [{ status: "M", path: "pnpm-lock.yaml" }] });
    expect(reason(confirmSourceWith(sourceSpec(), input))).toBe("path_mismatch");
  });

  it("is unsupported for a blob hash mismatch on either side", () => {
    const spec = sourceSpec();
    const before = `${BEFORE}\n`;
    expect(reason(confirmSourceWith(spec, sourceInput(before, AFTER)))).toBe("blob_hash_mismatch");
    const after = `${AFTER}\n`;
    expect(reason(confirmSourceWith(spec, sourceInput(BEFORE, after)))).toBe("blob_hash_mismatch");
    const wrongGitBlob = { ...spec, before: { ...spec.before, gitBlob: gitBlob("synthetic-other") } };
    expect(reason(confirmSourceWith(wrongGitBlob, sourceInput()))).toBe("blob_hash_mismatch");
  });

  it("is unsupported for any other commit or a parent that is not the first parent", () => {
    const spec = sourceSpec();
    const otherCommit = sourceInput(BEFORE, AFTER, { commit: "c000000000000000000000000000000000000003" });
    expect(reason(confirmSourceWith(spec, otherCommit))).toBe("unsupported_commit");
    const secondParent = sourceInput(BEFORE, AFTER, { parents: ["d000000000000000000000000000000000000004", SOURCE_PARENT] });
    expect(reason(confirmSourceWith(spec, secondParent))).toBe("not_first_parent");
    const noParents = sourceInput(BEFORE, AFTER, { parents: [] });
    expect(reason(confirmSourceWith(spec, noParents))).toBe("not_first_parent");
    const merge = sourceInput(BEFORE, AFTER, { parents: [SOURCE_PARENT, "d000000000000000000000000000000000000004"] });
    expect(reason(confirmSourceWith(spec, merge))).toBe("not_first_parent");
  });

  it("is unsupported when a blob is missing", () => {
    const input = { ...sourceInput(), before: undefined };
    expect(reason(confirmSourceWith(sourceSpec(), input))).toBe("blob_missing");
  });

  it("keeps the supported commit pairing in the package", () => {
    expect(DT1_SOURCE.commit).toBe("e6f3f3b4b40a490d5cb050471baa0999366dab2a");
    expect(DT1_SOURCE.parent).toBe("0a838649b773122cc68cbd0c3df78d4251b981c5");
    expect(reason(confirmSource(sourceInput()))).toBe("unsupported_commit");
  });

  it("gives identical record bytes for identical inputs", () => {
    const first = run();
    const second = run();
    expect(first.status).toBe("confirmed");
    if (first.status === "confirmed" && second.status === "confirmed") {
      expect(canonicalJson(first.record)).toBe(canonicalJson(second.record));
    }
  });
});
