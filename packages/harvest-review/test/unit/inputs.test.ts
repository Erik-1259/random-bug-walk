import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCandidateInput, buildInputs, parseReviewInputs } from "../../src/inputs.ts";
import type { CandidateInput, CandidateSource } from "../../src/inputs.ts";
import { HARVEST_RUN, SYNTHETIC_INPUTS } from "../support.ts";

const inputs = await buildInputs(HARVEST_RUN);

function candidate(name: string): CandidateInput {
  const found = inputs.candidates.find((entry) => entry.candidate_id.startsWith(`synthetic-org/${name}`));
  if (found === undefined) {
    throw new Error(`no candidate ${name}`);
  }
  return found;
}

describe("build-inputs on the harvest's committed synthetic run", () => {
  it("takes every candidate that matched the source rule, in funnel order", () => {
    expect(inputs.candidates.map((entry) => entry.candidate_id)).toEqual([
      "synthetic-org/synthetic-sql#7",
      "synthetic-org/synthetic-hook@ce1e0ac0c82ce451cfe1ef58791f3b8c105e0e0e",
      "synthetic-org/synthetic-new-function@a33cc94955626c9a3609de7ce4ae0baa43d5dbe0",
      "synthetic-org/synthetic-new-call@1bee8814de42248551e2ec7dfbdf5d06a0e5d80e",
      "synthetic-org/synthetic-already-passed@629738c7577c49dcb0499ed7b214f5987bce2a05",
      "synthetic-org/synthetic-constant-zone@b0fed2a52c92711dcc72c41cf3f82c82e9b77813",
      "synthetic-org/synthetic-global-zone@b753581403d59d4e0c3760d84aac342796a16ab9",
      "synthetic-org/synthetic-search-license@b28936956b98dc2768f9ea8def14eb83094b95bd",
      "synthetic-org/synthetic-backport@05a7d8ad21c25d8ef41ac3c18b0524c28d251dd5",
      "synthetic-org/synthetic-renamed@ce920eb7263bc005e035df8257250ea7c98379dc",
    ]);
  });

  it("records the repository, the commit, the reviewed match and its ast-grep outcome", () => {
    expect(candidate("synthetic-sql")).toMatchObject({
      repo: "synthetic-org/synthetic-sql",
      commit: "41a5470ec8cfca5a6864156bc280cdc649a3861c",
      path: "src/queries/stats.ts",
      previous_path: null,
      line: 3,
      call: 'getDateSQL("created_at", unit, filters.timezone)',
      function: "statsQuery",
      ast_grep: "confirmed",
    });
    expect(inputs.candidates.map((entry) => entry.ast_grep)).toEqual([
      "confirmed",
      "confirmed",
      "function_missing_before",
      "call_added",
      "before_has_timezone_argument",
      "timezone_is_constant",
      "timezone_unbound",
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
  });

  it("gives the after side's enclosing function, with line numbers", () => {
    expect(candidate("synthetic-hook").after).toEqual({
      start_line: 3,
      end_line: 7,
      text: [
        "3 | export function RangePage() {",
        "4 |   const { timezone } = useTimezone();",
        "5 |   const range = useDateRange({ timezone });",
        "6 |   return range;",
        "7 | }",
      ].join("\n"),
    });
    for (const entry of inputs.candidates) {
      expect(entry.after.text).toContain(`${String(entry.line)} | `);
      expect(entry.after.text).toContain(entry.call);
    }
  });

  it("gives the parent's function at the same path", () => {
    expect(candidate("synthetic-sql").before).toEqual([
      {
        start_line: 1,
        end_line: 4,
        text: [
          "1 | export function statsQuery(siteId: string, filters: { unit: string; timezone: string }) {",
          "2 |   const { unit } = filters;",
          '3 |   return getDateSQL("created_at", unit);',
          "4 | }",
        ].join("\n"),
      },
    ]);
  });

  it("gives no before function for a function_missing_before match", () => {
    const entry = candidate("synthetic-new-function");
    expect(entry.function).toBe("zoned");
    expect(entry.before).toEqual([]);
    expect(entry.after).toMatchObject({ start_line: 5, end_line: 7 });
  });

  it("selects the patch hunks that overlap the functions", () => {
    expect(candidate("synthetic-sql").hunks).toEqual([
      '@@ -3,1 +3,1 @@\n-  return getDateSQL("created_at", unit);\n+  return getDateSQL("created_at", unit, filters.timezone);',
    ]);
    expect(candidate("synthetic-new-function").hunks).toHaveLength(1);
  });

  it("reads a renamed file's parent blob from its old path", () => {
    const entry = candidate("synthetic-renamed");
    expect(entry.path).toBe("src/format/label.ts");
    expect(entry.previous_path).toBe("src/label-old.ts");
    expect(entry.before).toEqual([
      {
        start_line: 1,
        end_line: 3,
        text: "1 | export function label(d: Date, timezone: string) {\n2 |   return formatDate(d);\n3 | }",
      },
    ]);
  });

  it("matches the committed synthetic inputs, which the end-to-end tests read", () => {
    expect(parseReviewInputs(JSON.parse(readFileSync(SYNTHETIC_INPUTS, "utf8")))).toEqual(inputs);
  });
});

const SIBLINGS_BEFORE = `export function render(items: Item[], timezone: string) {
  items.forEach((item) => {
    log(formatDate(item.date));
  });
  return items.map((item) => item.id);
}

export function unrelated() {
  return 1;
}
`;
const SIBLINGS_AFTER = `export function render(items: Item[], timezone: string) {
  items.forEach((item) => {
    log(item.id);
  });
  return items.map((item) => formatDate(item.date, timezone));
}

export function unrelated() {
  return 2;
}
`;
const SIBLINGS_PATCH = [
  "@@ -3 +3 @@",
  "-    log(formatDate(item.date));",
  "+    log(item.id);",
  "@@ -5 +5 @@",
  "-  return items.map((item) => item.id);",
  "+  return items.map((item) => formatDate(item.date, timezone));",
  "@@ -9 +9 @@",
  "-  return 1;",
  "+  return 2;",
].join("\n");

function source(fields: Partial<CandidateSource> & Pick<CandidateSource, "before" | "after" | "patch" | "line" | "call">): CandidateSource {
  return {
    candidate_id: "synthetic-org/synthetic-hand-written@0000000000000000000000000000000000000001",
    repo: "synthetic-org/synthetic-hand-written",
    commit: "0000000000000000000000000000000000000001",
    path: "src/a.ts",
    previous_path: null,
    ast_grep: "confirmed",
    ...fields,
  };
}

describe("the input builder on hand-written sources", () => {
  it("gives every sibling anonymous callback at the same path, and only the hunks that overlap them", () => {
    const entry = buildCandidateInput(
      source({ before: SIBLINGS_BEFORE, after: SIBLINGS_AFTER, patch: SIBLINGS_PATCH, line: 5, call: "formatDate(item.date, timezone)" }),
    );
    expect(entry.function).toBe("render/<anonymous>");
    expect(entry.after).toEqual({ start_line: 5, end_line: 5, text: "5 |   return items.map((item) => formatDate(item.date, timezone));" });
    expect(entry.before).toEqual([
      { start_line: 2, end_line: 4, text: "2 |   items.forEach((item) => {\n3 |     log(formatDate(item.date));\n4 |   });" },
      { start_line: 5, end_line: 5, text: "5 |   return items.map((item) => item.id);" },
    ]);
    expect(entry.hunks).toEqual([
      "@@ -3 +3 @@\n-    log(formatDate(item.date));\n+    log(item.id);",
      "@@ -5 +5 @@\n-  return items.map((item) => item.id);\n+  return items.map((item) => formatDate(item.date, timezone));",
    ]);
  });

  it("gives both same-named methods of two classes", () => {
    const before = `class A {
  label(d: Date) {
    return formatDate(d);
  }
}
class B {
  label(d: Date, timezone: string) {
    return formatDate(d);
  }
}
`;
    const after = before.replace("  label(d: Date, timezone: string) {\n    return formatDate(d);", "  label(d: Date, timezone: string) {\n    return formatDate(d, timezone);");
    const entry = buildCandidateInput(
      source({ before, after, patch: "@@ -8 +8 @@\n-    return formatDate(d);\n+    return formatDate(d, timezone);", line: 8, call: "formatDate(d, timezone)" }),
    );
    expect(entry.function).toBe("label");
    expect(entry.after).toMatchObject({ start_line: 7, end_line: 9 });
    expect(entry.before.map((fn) => [fn.start_line, fn.end_line])).toEqual([
      [2, 4],
      [7, 9],
    ]);
    expect(entry.hunks).toHaveLength(1);
  });

  it("finds the after call by its line and its text", () => {
    const after = "export const a = () => formatDate(d), b = (timezone: string) => formatDate(d, timezone);\n";
    const entry = buildCandidateInput(
      source({ before: "export const a = () => formatDate(d), b = (timezone: string) => formatDate(d);\n", after, patch: "@@ -1 +1 @@\n-x\n+y", line: 1, call: "formatDate(d, timezone)" }),
    );
    expect(entry.function).toBe("b");
    expect(entry.before).toHaveLength(1);
    expect(entry.before[0]?.text).toContain("b = (timezone: string) => formatDate(d);");
  });

  it("gives the whole file at <module>", () => {
    const before = 'import { formatDate } from "./dates";\nexport const shown = formatDate(now);\n';
    const after = 'import { formatDate } from "./dates";\nexport const shown = formatDate(now, timezone);\n';
    const entry = buildCandidateInput(source({ before, after, patch: "@@ -2 +2 @@\n-a\n+b", line: 2, call: "formatDate(now, timezone)" }));
    expect(entry.function).toBe("<module>");
    expect(entry.after).toEqual({ start_line: 1, end_line: 2, text: '1 | import { formatDate } from "./dates";\n2 | export const shown = formatDate(now, timezone);' });
    expect(entry.before).toEqual([{ start_line: 1, end_line: 2, text: '1 | import { formatDate } from "./dates";\n2 | export const shown = formatDate(now);' }]);
  });

  it("gives none before for function_missing_before even when a function at that path exists", () => {
    const entry = buildCandidateInput(
      source({ before: SIBLINGS_BEFORE, after: SIBLINGS_AFTER, patch: SIBLINGS_PATCH, line: 5, call: "formatDate(item.date, timezone)", ast_grep: "function_missing_before" }),
    );
    expect(entry.before).toEqual([]);
    expect(entry.hunks).toHaveLength(1);
  });

  it("refuses a match whose call is not on its line", () => {
    expect(() =>
      buildCandidateInput(source({ before: SIBLINGS_BEFORE, after: SIBLINGS_AFTER, patch: SIBLINGS_PATCH, line: 4, call: "formatDate(item.date, timezone)" })),
    ).toThrow("line 4");
  });
});
