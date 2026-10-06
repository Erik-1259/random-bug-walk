import { describe, expect, it } from "vitest";
import { addedLines, candidateRule, examineFile } from "../../src/confirm.ts";

function examine(path: string, before: string, after: string, added?: number[]): ReturnType<typeof examineFile> {
  const lines = added ?? after.split("\n").flatMap((line, index) => (before.split("\n").includes(line) ? [] : [index + 1]));
  return examineFile(path, before, after, new Set(lines));
}

describe("candidate source rule and structural confirmation", () => {
  it("confirms a date-range call that gains a time zone bound from a hook in the same function", () => {
    const before = "export function Page() {\n  const range = useDateRange();\n  return range;\n}\n";
    const after = "export function Page() {\n  const { timezone } = useTimezone();\n  const range = useDateRange({ timezone });\n  return range;\n}\n";
    const [match] = examine("src/Page.tsx", before, after);
    expect(match).toEqual({
      line: 3,
      call: "useDateRange({ timezone })",
      callee: "useDateRange",
      function: "Page",
      outcome: { status: "confirmed", before_call: "useDateRange()", before_line: 2, timezone: "timezone" },
    });
  });

  it("confirms a time zone read from a parameter's member", () => {
    const before = "function q(id: string, filters: F) {\n  return getDateSQL('at', filters.unit);\n}\n";
    const after = "function q(id: string, filters: F) {\n  return getDateSQL('at', filters.unit, filters.timezone);\n}\n";
    expect(examine("src/q.ts", before, after)[0]?.outcome).toMatchObject({ status: "confirmed", timezone: "filters" });
  });

  it("confirms inside an arrow function named by its variable", () => {
    const before = "export const show = (d, tz) => formatDate(d);\n";
    const after = "export const show = (d, tz) => formatDate(d, tz);\n";
    expect(examine("src/a.js", before, after)[0]).toMatchObject({ function: "show", outcome: { status: "confirmed", timezone: "tz" } });
  });

  it("confirms a time zone imported at module level", () => {
    const before = 'import { zone } from "./config";\nexport function f(d) {\n  return d.toLocaleDateString("en");\n}\n';
    const after = 'import { zone } from "./config";\nexport function f(d) {\n  return d.toLocaleDateString("en", { timeZone: zone });\n}\n';
    expect(examine("src/a.jsx", before, after)[0]?.outcome).toMatchObject({ status: "confirmed", timezone: "zone" });
  });

  it("matches a time zone added on its own line inside a multi-line call", () => {
    const before = 'function f(d: Date, timezone: string) {\n  return formatDate(d, {\n    format: "x",\n  });\n}\n';
    const after = 'function f(d: Date, timezone: string) {\n  return formatDate(d, {\n    format: "x",\n    timeZone: timezone,\n  });\n}\n';
    const [match] = examine("src/a.ts", before, after, [4]);
    expect(match).toMatchObject({ line: 2, callee: "formatDate", outcome: { status: "confirmed", timezone: "timezone" } });
  });

  it("reads the name behind a fallback, a cast or a call", () => {
    const cases = ['user?.timezone ?? "UTC"', "(opts.timeZone || defaultZone) as string", "getZone()"];
    for (const value of cases) {
      const before = `import { getZone } from "./z";\nfunction f(d: Date, user: U, opts: O) {\n  return formatDate(d, {});\n}\n`;
      const after = before.replace("formatDate(d, {})", `formatDate(d, { timeZone: ${value} })`);
      expect(examine("src/a.ts", before, after)[0]?.outcome, value).toMatchObject({ status: "confirmed" });
    }
  });

  it("rejects a value with no name to resolve as timezone_unbound", () => {
    const before = "function f(d, region, city) {\n  return formatDate(d, {});\n}\n";
    const after = "function f(d, region, city) {\n  return formatDate(d, { timeZone: `${region}/${city}` });\n}\n";
    expect(examine("src/a.js", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_unbound" });
  });

  it("rejects the runtime's guessed zone as a constant, even from an imported library", () => {
    for (const value of ["dayjs.tz.guess()", "Intl.DateTimeFormat().resolvedOptions().timeZone", "moment.tz.guess() ?? fallback"]) {
      const before = 'import dayjs from "dayjs";\nimport moment from "moment";\nfunction f(d, fallback) {\n  return formatDate(d, {});\n}\n';
      const after = before.replace("formatDate(d, {})", `formatDate(d, { timeZone: ${value} })`);
      expect(examine("src/a.js", before, after)[0]?.outcome, value).toMatchObject({ reason: "timezone_is_constant" });
    }
  });

  it("rejects undefined and template literals with no substitution as constants", () => {
    for (const value of ["undefined", "`UTC`"]) {
      const after = `function f(d) {\n  return formatDate(d, { timeZone: ${value} });\n}\n`;
      expect(examine("src/a.js", "function f(d) {\n  return formatDate(d, {});\n}\n", after)[0]?.outcome, value).toMatchObject({ reason: "timezone_is_constant" });
    }
  });

  it("ignores rule matches outside the added lines", () => {
    const before = "function f(d, timezone) {\n  formatDate(d, timezone);\n  formatDate(d);\n}\n";
    const after = "function f(d, timezone) {\n  formatDate(d, timezone);\n  formatDate(d, 'x');\n}\n";
    expect(examine("src/a.ts", before, after, [3])).toEqual([]);
  });

  it("does not match a call whose callee is not a date operation", () => {
    expect(examine("src/a.ts", "function f(timezone) {\n  send();\n}\n", "function f(timezone) {\n  send(timezone);\n}\n")).toEqual([]);
  });

  it("does not match a time zone nested inside another argument expression", () => {
    const after = "function f(d, timezone) {\n  return formatDate(shift(d, timezone));\n}\n";
    expect(examine("src/a.ts", "function f(d, timezone) {\n  return formatDate(d);\n}\n", after)).toEqual([]);
  });

  it("rejects a call in a function the parent does not have (function_missing_before)", () => {
    const after = "function g(d, timezone) {\n  return formatDate(d, timezone);\n}\n";
    expect(examine("src/a.ts", "const x = 1;\n", after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "function_missing_before" });
  });

  it("rejects a new call rather than a changed one (call_added)", () => {
    const before = "function f(d, timezone) {\n  return formatDate(d);\n}\n";
    const after = "function f(d, timezone) {\n  const a = formatDate(d, timezone);\n  return formatDate(d);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "call_added" });
  });

  it("rejects a call that already passed a time zone (before_has_timezone_argument)", () => {
    const before = "function f(d, timezone) {\n  return formatInTimeZone(d, timezone, 'y');\n}\n";
    const after = "function f(d, timezone) {\n  return formatInTimeZone(d, timezone, 'yy');\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "before_has_timezone_argument" });
  });

  it("rejects a literal time zone (timezone_is_constant)", () => {
    const before = "function f(d) {\n  return d.toLocaleDateString('en');\n}\n";
    const after = "function f(d) {\n  return d.toLocaleDateString('en', { timeZone: 'UTC' });\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_is_constant" });
  });

  it("rejects a time zone with no binding in scope (timezone_unbound)", () => {
    const before = "function f(d) {\n  return formatDate(d);\n}\n";
    const after = "function f(d) {\n  return formatDate(d, timezone);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_unbound" });
  });

  it("does not count a binding in a sibling function as in scope", () => {
    const before = "function g() {\n  const timezone = 'x';\n}\nfunction f(d) {\n  return formatDate(d);\n}\n";
    const after = "function g() {\n  const timezone = 'x';\n}\nfunction f(d) {\n  return formatDate(d, timezone);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_unbound" });
  });

  it("loads one rule per parser language from the committed rule file", () => {
    expect(candidateRule("src/a.ts").language).toBe("TypeScript");
    expect(candidateRule("src/a.tsx").language).toBe("Tsx");
    expect(candidateRule("src/a.js").language).toBe("Tsx");
  });

  it("reads the added lines of a GitHub patch, ignoring no-newline markers", () => {
    const patch = "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n@@ -10,2 +11,2 @@\n x\n-y\n+z";
    expect([...addedLines(patch)]).toEqual([2, 3, 12]);
  });
});
