// Version 1 stays the evaluator of the recorded version 1 qualification: these are the hashes its
// freeze recorded, recomputed from this tree with the freeze's recipe (the tree hash of every file
// under the listed paths, keyed by its path relative to the base directory). Version 2 adds files
// beside them and changes none of them; the package manifest is the one exception, and the test
// pins its version 1 hash so the rest of the evaluator tree still reproduces the frozen value.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashTree, sha256Hex, treeSha256 } from "../src/hash.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const kit = fileURLToPath(new URL("../../../kit/task-report", import.meta.url));

/** The freeze's recipe: every file under each path, keyed relative to `base`. */
function recipe(base: string, paths: readonly string[], replace: Record<string, string> = {}): { tree: string; files: number } {
  const files: Record<string, string> = {};
  for (const path of paths) {
    if (statSync(`${base}/${path}`).isFile()) {
      files[path] = sha256Hex(readFileSync(`${base}/${path}`));
      continue;
    }
    for (const [rel, hash] of Object.entries(hashTree(`${base}/${path}`).files)) files[`${path}/${rel}`] = hash;
  }
  Object.assign(files, replace);
  return { tree: treeSha256(files), files: Object.keys(files).length };
}

describe("version 1 frozen hashes", () => {
  it("the data file, the version 1 protocol and the version 1 catalog are byte-identical", () => {
    expect(sha256Hex(readFileSync(`${pkg}/data/f3.v1.json`))).toBe("02db325c908b4f71834f9554239ad4f289a7e7500b6c77f4d647a287c0dbf5b5");
    expect(sha256Hex(readFileSync(`${pkg}/protocol/f3-repeatability.v1.json`))).toBe("56cdd1fe2bf5473f3106f532a39ec43bce1144cf05eb756135da58540005730a");
    expect(sha256Hex(readFileSync(`${pkg}/catalog/v1.json`))).toBe("548b3bdf898fa52b7fd036e3e7d87f495df706b716d567cf0169987f317e9471");
  });

  it("the check code src/f3 and the kit's Dockerfile, bin and etc reproduce their frozen trees", () => {
    expect(recipe(pkg, ["src/f3"])).toEqual({ tree: "c84093536e87fc300d1110e4cc49c73494edbbe4d9fd2d8c1c6b6f2b2c1b5fde", files: 9 });
    expect(recipe(kit, ["Dockerfile", "bin", "etc"])).toEqual({ tree: "862a7f318896768d7b35687bdef691530fa17347b8a459d5f89871ac52e61dfc", files: 9 });
  });

  it("the evaluator tree reproduces its frozen value with the version 1 package manifest", () => {
    const v1Manifest = "d17732a3c5d390807e006cd5649d0453d3e223efcb3d454a40af09b7a27e72e3";
    expect(recipe(pkg, ["package.json", "src", "data", "protocol", "baseline"], { "package.json": v1Manifest })).toEqual({
      tree: "4aa9eb93ee192e780a8cc25a28ea6bcb8d863a65896c6961db89e71e9c79e2d2",
      files: 27,
    });
  });
});
