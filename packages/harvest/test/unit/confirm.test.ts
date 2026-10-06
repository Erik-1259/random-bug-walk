import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addedLines, CANDIDATE_RULE_FILE, candidateRule, examineFile, TIMEZONE_NAME, TIMEZONE_TEXT } from "../../src/confirm.ts";

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
    const before = "function f(d, zone, timezone) {\n  return formatInTimeZone(d, zone, 'y');\n}\n";
    const after = "function f(d, zone, timezone) {\n  return formatInTimeZone(d, timezone, 'y');\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "before_has_timezone_argument" });
  });

  it("does not match a callee that only contains a date word inside another word", () => {
    for (const callee of ["updatePreferences", "user.updatePreferences", "mandated", "setTimeout"]) {
      const after = `function f(user, timezone) {\n  ${callee}(user, timezone);\n}\n`;
      expect(examine("src/a.ts", `function f(user, timezone) {\n  ${callee}(user);\n}\n`, after), callee).toEqual([]);
    }
  });

  it("matches known date functions and callees with a whole date word", () => {
    for (const callee of ["format", "formatInTimeZone", "toZonedTime", "startOfMonth", "dayjs(d).tz", "formatDate", "getDateRange", "get_date_range", "ui.renderDays"]) {
      const after = `function f(d, timezone) {\n  return ${callee}(d, timezone);\n}\n`;
      expect(examine("src/a.ts", `function f(d, timezone) {\n  return ${callee}(d);\n}\n`, after)[0]?.outcome, callee).toMatchObject({ status: "confirmed" });
    }
  });

  it("does not match a time-zone word followed by a further word", () => {
    for (const value of ["timezoneOffset", "myTimezoneValue", "user.timezoneOffset", "{ tzName: name }"]) {
      const before = "function f(d, user, name, timezoneOffset, myTimezoneValue) {\n  return formatDate(d);\n}\n";
      const after = before.replace("formatDate(d)", `formatDate(d, ${value})`);
      expect(examine("src/a.ts", before, after), value).toEqual([]);
    }
  });

  it("matches a whole time-zone name or one that ends in a time-zone word", () => {
    for (const value of ["timezone", "userTimezone", "user.timezone", "user_time_zone", "selectedTZ", "{ timeZone: userTz }"]) {
      const before = "function f(d, user, timezone, userTimezone, user_time_zone, selectedTZ, userTz) {\n  return formatDate(d);\n}\n";
      const after = before.replace("formatDate(d)", `formatDate(d, ${value})`);
      expect(examine("src/a.ts", before, after)[0]?.outcome, value).toMatchObject({ status: "confirmed" });
    }
  });

  it("uses the confirmation's time-zone name pattern at every time-zone check in the rule file", () => {
    const rules = readFileSync(CANDIDATE_RULE_FILE, "utf8");
    expect(rules.split(TIMEZONE_NAME.source).length - 1).toBe(8);
  });

  it("rejects a parent call with different other arguments as call_added", () => {
    const before = "function f(a, b, timezone) {\n  return formatDate(a);\n}\n";
    const after = "function f(a, b, timezone) {\n  return formatDate(b, timezone);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "call_added" });
  });

  it("pairs a call by its other arguments, ignoring whitespace and the new time-zone property", () => {
    const before = "function f(a, b, timezone) {\n  formatDate(a,  { format: 'x' });\n  return formatDate(b);\n}\n";
    const after = "function f(a, b, timezone) {\n  formatDate(b);\n  return formatDate(a, {\n    format: 'x',\n    timeZone: timezone,\n  });\n}\n";
    expect(examine("src/a.ts", before, after, [5])[0]?.outcome).toMatchObject({
      status: "confirmed",
      before_call: "formatDate(a,  { format: 'x' })",
      before_line: 2,
    });
  });

  it("does not pair with a parent call that another call of the commit keeps unchanged", () => {
    const before = "function f(start, end, timezone) {\n  const a = formatDate(start);\n  const b = formatDate(end);\n}\n";
    const after = "function f(start, end, timezone) {\n  const a = formatDate(start);\n  const b = formatDate(start, timezone);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "call_added" });
  });

  it("pairs one of two identical parent calls when the other stays unchanged", () => {
    const before = "function f(d, timezone) {\n  formatDate(d);\n  return formatDate(d);\n}\n";
    const after = "function f(d, timezone) {\n  formatDate(d);\n  return formatDate(d, timezone);\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "confirmed", before_line: 3 });
  });

  it("keeps added text with a name ending in a time-zone word in the cheap text filter", () => {
    for (const text of ["+  formatDate(d, USER_TZ);", "+  formatDate(d, userTz);", "+  formatDate(d, userZone);", "+  formatDate(d, user_tz);"]) {
      expect(TIMEZONE_TEXT.test(text), text).toBe(true);
    }
  });

  it("rejects a literal time zone (timezone_is_constant)", () => {
    const before = "function f(d) {\n  return d.toLocaleDateString('en');\n}\n";
    const after = "function f(d) {\n  return d.toLocaleDateString('en', { timeZone: 'UTC' });\n}\n";
    expect(examine("src/a.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_is_constant" });
  });

  it("rejects a plain name whose declaration is initialized with a literal or the runtime zone", () => {
    for (const value of ['"UTC"', "Intl.DateTimeFormat().resolvedOptions().timeZone"]) {
      const before = `function f(d) {\n  const timezone = ${value};\n  return formatDate(d);\n}\n`;
      const after = before.replace("formatDate(d)", "formatDate(d, timezone)");
      expect(examine("src/a.js", before, after)[0]?.outcome, value).toMatchObject({ status: "rejected", reason: "timezone_is_constant" });
    }
  });

  it("rejects a plain name destructured from the runtime's resolved options", () => {
    const before = "function f(d) {\n  const { timeZone } = Intl.DateTimeFormat().resolvedOptions();\n  return formatDate(d, {});\n}\n";
    const after = before.replace("formatDate(d, {})", "formatDate(d, { timeZone })");
    expect(examine("src/a.js", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "timezone_is_constant" });
  });

  it("rejects a module-level constant time zone passed through an object property", () => {
    for (const before of ['const TZ = "UTC";\nexport function f(d) {\n  return formatDate(d, {});\n}\n', 'export const TZ = "UTC";\nexport function f(d) {\n  return formatDate(d, {});\n}\n']) {
      const after = before.replace("formatDate(d, {})", "formatDate(d, { timeZone: TZ })");
      expect(examine("src/a.ts", before, after)[0]?.outcome, before).toMatchObject({ status: "rejected", reason: "timezone_is_constant" });
    }
  });

  it("accepts a plain name from a parameter, a property read or a declaration with no initializer", () => {
    const sources = [
      "function f(d, timezone) {\n  return formatDate(d);\n}\n",
      "function f(d, user) {\n  const timezone = user.timezone;\n  return formatDate(d);\n}\n",
      "function f(d) {\n  let timezone;\n  timezone = pick();\n  return formatDate(d);\n}\n",
      'const timezone = "UTC";\nfunction f(d, timezone) {\n  return formatDate(d);\n}\n',
      "export const timezone = pick();\nexport function f(d) {\n  return formatDate(d);\n}\n",
    ];
    for (const before of sources) {
      const after = before.replace("formatDate(d)", "formatDate(d, timezone)");
      expect(examine("src/a.js", before, after)[0]?.outcome, before).toMatchObject({ status: "confirmed", timezone: "timezone" });
    }
  });

  it("accepts a time zone from an ambient module or global declaration", () => {
    for (const declaration of ["declare const timezone: string;", "declare global {\n  const timezone: string;\n}"]) {
      const before = `${declaration}\nexport function f(d: Date) {\n  return formatDate(d);\n}\n`;
      const after = before.replace("formatDate(d)", "formatDate(d, timezone)");
      expect(examine("src/a.ts", before, after)[0]?.outcome, declaration).toMatchObject({ status: "confirmed", timezone: "timezone" });
    }
  });

  it("does not let a constant declared in a block, case or loop the call is outside of hide the binding it reads", () => {
    const sources = [
      'const timezone = pick();\nfunction f(d, x) {\n  if (x) {\n    const timezone = "UTC";\n    log(timezone);\n  }\n  return formatDate(d);\n}\n',
      'const timezone = pick();\nfunction f(d, k) {\n  switch (k) {\n    case 1:\n      const timezone = "UTC";\n      log(timezone);\n  }\n  return formatDate(d);\n}\n',
      "const timezone = pick();\nfunction f(d) {\n  for (let timezone = 0; timezone < 1; timezone++) {}\n  return formatDate(d);\n}\n",
    ];
    for (const before of sources) {
      const after = before.replace("formatDate(d)", "formatDate(d, timezone)");
      expect(examine("src/a.js", before, after)[0]?.outcome, before).toMatchObject({ status: "confirmed", timezone: "timezone" });
    }
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
