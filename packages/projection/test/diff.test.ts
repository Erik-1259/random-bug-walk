import { describe, expect, it } from "vitest";
import { addedLines, applyPatch, parseDiff } from "../src/diff.ts";
import { InputError } from "../src/input.ts";

const ORIGINAL = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

function only(diff: string): ReturnType<typeof parseDiff>[number] {
  const patches = parseDiff(diff);
  expect(patches).toHaveLength(1);
  const [patch] = patches;
  if (patch === undefined) throw new Error("no patch");
  return patch;
}

const TWO_HUNKS = [
  "diff --git a/f.txt b/f.txt",
  "index 1111111..2222222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -8,3 +8,4 @@ seven",
  " eight",
  " nine",
  "+nine and a half",
  " ten",
  "",
].join("\n");

describe("unified diff", () => {
  it("ADM-01 applies hunks exactly and reverses them", () => {
    const patch = only(TWO_HUNKS);
    expect(patch.path).toBe("f.txt");
    const result = applyPatch(Buffer.from(ORIGINAL), patch, "forward");
    expect(result?.toString()).toBe("one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nnine and a half\nten\n");
    expect(applyPatch(result ?? Buffer.alloc(0), patch, "reverse")?.toString()).toBe(ORIGINAL);
    expect(addedLines(patch)).toEqual([2, 10]);
  });

  it("ADM-01 refuses to apply when context or removed lines differ, with no fuzz or offset", () => {
    const patch = only(TWO_HUNKS);
    expect(applyPatch(Buffer.from(ORIGINAL.replace("three", "3")), patch, "forward")).toBeNull();
    expect(applyPatch(Buffer.from(`zero\n${ORIGINAL}`), patch, "forward")).toBeNull();
    expect(applyPatch(Buffer.from(ORIGINAL), patch, "reverse")).toBeNull();
  });

  it("ADM-01 handles a missing newline at end of file on either side", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b", ""].join("\n");
    const patch = only(diff);
    expect(applyPatch(Buffer.from("a\nb"), patch, "forward")?.toString()).toBe("a\nb\n");
    expect(applyPatch(Buffer.from("a\nb\n"), patch, "forward")).toBeNull();
    expect(applyPatch(Buffer.from("a\nb\n"), patch, "reverse")?.toString()).toBe("a\nb");
  });

  it("ADM-01 refuses a missing-newline marker that is not on the last line of its side", () => {
    const misplaced = only(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "+c", " b", ""].join("\n"));
    expect(applyPatch(Buffer.from("c\nb\n"), misplaced, "reverse")).toBeNull();
    expect(applyPatch(Buffer.from("ab\n"), misplaced, "forward")).toBeNull();
    const sameSide = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "-b", "+c", "+d", ""].join("\n");
    expect(() => parseDiff(sameSide)).toThrow(InputError);
    const phantom = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,1 @@", "-a", "+c", "-", "\\ No newline at end of file", ""].join("\n");
    expect(() => parseDiff(phantom)).toThrow(InputError);
    const context = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " a", "\\ No newline at end of file", "-b", "+c", ""].join("\n");
    expect(() => parseDiff(context)).toThrow(InputError);
  });

  it("ADM-01 applies an insertion at the start and a deletion of whole lines", () => {
    const insert = only(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1 @@", "+first", ""].join("\n"));
    expect(applyPatch(Buffer.from("x\n"), insert, "forward")?.toString()).toBe("first\nx\n");
    const remove = only(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -2 +1,0 @@", "-x", ""].join("\n"));
    expect(applyPatch(Buffer.from("a\nx\n"), remove, "forward")?.toString()).toBe("a\n");
    expect(addedLines(remove)).toEqual([]);
  });

  it("ADM-01 keeps carriage returns as bytes", () => {
    const patch = only(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a\r", "+b\r", ""].join("\n"));
    expect(applyPatch(Buffer.from("a\r\n"), patch, "forward")?.toString()).toBe("b\r\n");
    expect(applyPatch(Buffer.from("a\n"), patch, "forward")).toBeNull();
  });

  it("ADM-01 reads paths with spaces from the --- and +++ lines", () => {
    const patch = only(["diff --git a/my file.txt b/my file.txt", "--- a/my file.txt\t", "+++ b/my file.txt\t", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
    expect(patch.path).toBe("my file.txt");
  });

  it("ADM-01 rejects malformed or non-modification diffs", () => {
    const bad = [
      "",
      "garbage\n",
      ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " a", "-b", ""].join("\n"),
      ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b", "trailing", ""].join("\n"),
      ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "", ""].join("\n"),
      ["diff --git a/f b/g", "--- a/f", "+++ b/g", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
      ["diff --git a/f b/f", "deleted file mode 100644", "--- a/f", "+++ /dev/null", "@@ -1 +0,0 @@", "-a", ""].join("\n"),
      ["diff --git a/f b/f", "similarity index 90%", "rename from f", "rename to g", ""].join("\n"),
      ["diff --git a/f b/f", "Binary files a/f and b/f differ", ""].join("\n"),
      ['diff --git "a/f\\tx" "b/f\\tx"', '--- "a/f\\tx"', '+++ "b/f\\tx"', "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
      ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3 +3 @@", "-a", "+b", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
      ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b", "diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -5 +5 @@", "-a", "+b", ""].join("\n"),
      ["diff --git a/../f b/../f", "--- a/../f", "+++ b/../f", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    ];
    for (const diff of bad) expect(() => parseDiff(diff), JSON.stringify(diff)).toThrow(InputError);
  });
});
