import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIT_IMAGE_FILE, KitImageError, loadKitImage } from "../adapter/kit.ts";
import { PACKAGE_DIR, QualifyError, main, writeKitImagePin } from "../adapter/qualify.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const TAG = "rbw-task-report:synthetic-build";
const IMAGE_ID = `sha256:${"a1".repeat(32)}`;

function pinFile(): string {
  return join(mkdtempSync(join(tmpdir(), "rbw-qualify-test-")), "kit-image.v2.json");
}

describe("qualify pin", () => {
  it("pins the built image by its reference, image ID and architecture, which prepare and evaluate then load", () => {
    const file = pinFile();
    const pin = writeKitImagePin(file, TAG, `${IMAGE_ID} amd64\n`);
    expect(pin).toEqual({ reference: TAG, digest: IMAGE_ID, architecture: "amd64" });
    expect(loadKitImage(file)).toEqual(pin);
    // pin writes the file the adapter reads by default in prepare and evaluate.
    expect(KIT_IMAGE_FILE).toBe(join(PACKAGE_DIR, "catalog/kit-image.v2.json"));
  });

  it("refuses an image it cannot identify and leaves the pin unwritten", () => {
    const file = pinFile();
    expect(() => writeKitImagePin(file, TAG, "")).toThrow(KitImageError);
    expect(() => writeKitImagePin(file, TAG, `${IMAGE_ID} s390x`)).toThrow(KitImageError);
    expect(() => writeKitImagePin(file, TAG, "sha256:short arm64")).toThrow(KitImageError);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a tag the build would refuse, before asking Docker", async () => {
    await expect(main(["pin", "--tag", "synthetic-other:latest"])).rejects.toThrow(new QualifyError("--tag must be rbw-task-report:<name>"));
  });

  it("the README's version 2 commands pin the image they build before prepare", () => {
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    const steps = readme
      .split("\n")
      .filter((line) => line.startsWith("node packages/host-task-report/adapter/qualify.ts "))
      .map((line) => line.trim().split(/\s+/).slice(2));
    expect(steps.map((step) => step[0])).toEqual(["build", "pin", "prepare", "run", "evaluate"]);
    expect(steps[1]).toEqual(["pin", ...(steps[0] ?? []).slice(1)]);
  });
});
