// The bug family a release's judge job is built for, from the build command's flags. With no family
// flag the job is the released time-zone family's. A fixture package names its own probes and
// alternative fix: all three flags or none, so another family can never fall back to the time-zone
// family's probes or fix.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Fixture } from "@rbw/umami-fixture";
import { ReleaseInputError } from "./errors.ts";
import { TIME_ZONE_FAMILY } from "./judge-job.ts";
import type { JudgeJobFamily } from "./judge-job.ts";

export interface FamilyOptions {
  /** A fixture package directory whose src/index.ts exports FIXTURE_FILE and loadFixture, as @rbw/umami-fixture does. */
  fixturePackage?: string;
  /** The family's probe directory. */
  probesDir?: string;
  /** The family's alternative fix directory. */
  alternativeDir?: string;
}

/** The family the flags name: the time-zone family when none is given, else all three are required. */
export async function familyFrom(options: FamilyOptions): Promise<Readonly<JudgeJobFamily>> {
  const { fixturePackage, probesDir, alternativeDir } = options;
  if (fixturePackage === undefined && probesDir === undefined && alternativeDir === undefined) return TIME_ZONE_FAMILY;
  if (fixturePackage === undefined || probesDir === undefined || alternativeDir === undefined) {
    throw new ReleaseInputError("family_incomplete", "--fixture-package, --probes and --alternative-fix go together");
  }
  let module: { FIXTURE_FILE?: unknown; loadFixture?: unknown };
  try {
    module = (await import(pathToFileURL(join(fixturePackage, "src", "index.ts")).href)) as typeof module;
  } catch {
    throw new ReleaseInputError("fixture_package_invalid", "its src/index.ts cannot be loaded");
  }
  const { FIXTURE_FILE: fixtureFile, loadFixture } = module;
  if (!(typeof fixtureFile === "string" || fixtureFile instanceof URL) || typeof loadFixture !== "function") {
    throw new ReleaseInputError("fixture_package_invalid", "it must export FIXTURE_FILE and loadFixture");
  }
  return { fixtureFile, loadFixture: loadFixture as () => Fixture, probesDir, alternativeDir };
}
