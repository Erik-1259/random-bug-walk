// The bug families a run can select: which fixture package the kit stage holds, which probe set
// the code states come from, whether an alternative fix exists, which kit image the run needs and
// the database latency its Toxiproxy applies. The time-zone family is the default and is exactly
// what every run used before families could be selected.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@rbw/schema";
import type { Adm06Applicability, CodeState } from "@rbw/schema";
import { PROBE_DIR, RC1_PROBE_DIR } from "@rbw/shapes";
import type { ProbeSet } from "@rbw/shapes";
import { FIXTURE_FILE as TZ_FIXTURE_FILE, loadFixture as loadTzFixture } from "@rbw/umami-fixture";
import { FIXTURE_FILE as RACE_FIXTURE_FILE, loadFixture as loadRaceFixture } from "@rbw/umami-fixture-rc1";
import { ALTERNATIVE_FIX_DIR } from "./code-states.ts";

export const FAMILY_IDS = ["time-zone", "race"] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];
export const DEFAULT_FAMILY: FamilyId = "time-zone";

/** One row of a fixture's outcome vector, the shape both fixture packages write. */
export interface FixtureRow {
  readonly check_id: string;
  readonly observed: string;
  readonly failure_code: string | null;
}

/** What the runner reads from a family's fixture: one outcome vector per code state the family uses. */
export interface FamilyFixture {
  readonly outcome_vectors: Readonly<Partial<Record<CodeState, readonly FixtureRow[]>>>;
}

/** The image manifest schema of each kit image (`/opt/rbw/verifier/image-manifest.json`). */
export const TZ_IMAGE_SCHEMA = "rbw-umami-kit-image-manifest/1";
export const RACE_IMAGE_SCHEMA = "rbw-umami-race-kit-image-manifest/1";

/** The largest latency `rbw-proxy set-latency` accepts. */
export const MAX_RACE_LATENCY_MS = 10_000;

export interface Family {
  readonly id: FamilyId;
  /** The fixture package that `stage-kit.ts --fixture-package` stages into the kit's umami-fixture slot. */
  readonly fixturePackage: string;
  /** The fixture's data file; the kit stage must hold the same bytes. */
  readonly fixtureFile: URL;
  readonly loadFixture: () => FamilyFixture;
  readonly probesDir: string;
  /** This package's alternative fix, or null when the family has none. */
  readonly alternativeDir: string | null;
  /** The schema the kit image's manifest must have. */
  readonly imageSchema: string;
  /** Whether the kit image puts Toxiproxy between Umami and Postgres, so a run may set its latency. */
  readonly proxy: boolean;
}

/** The package directory that holds a fixture data file (data/<file> inside the package). */
const packageOf = (file: URL): string => dirname(dirname(fileURLToPath(file)));

export const FAMILIES: Readonly<Record<FamilyId, Family>> = {
  "time-zone": {
    id: "time-zone",
    fixturePackage: packageOf(TZ_FIXTURE_FILE),
    fixtureFile: TZ_FIXTURE_FILE,
    loadFixture: loadTzFixture,
    probesDir: PROBE_DIR,
    alternativeDir: ALTERNATIVE_FIX_DIR,
    imageSchema: TZ_IMAGE_SCHEMA,
    proxy: false,
  },
  race: {
    id: "race",
    fixturePackage: packageOf(RACE_FIXTURE_FILE),
    fixtureFile: RACE_FIXTURE_FILE,
    loadFixture: loadRaceFixture,
    probesDir: RC1_PROBE_DIR,
    alternativeDir: null,
    imageSchema: RACE_IMAGE_SCHEMA,
    proxy: true,
  },
};

export class FamilyError extends Error {
  override name = "FamilyError";
}

/** The family a command line names; the time-zone family when it names none. */
export function familyFor(id: string | undefined): Family {
  if (id === undefined) return FAMILIES[DEFAULT_FAMILY];
  const found = FAMILY_IDS.find((item) => item === id);
  if (found === undefined) throw new FamilyError(`unknown family ${id}; expected one of ${FAMILY_IDS.join(", ")}`);
  return FAMILIES[found];
}

/**
 * The per-copy database latency: null for a family without the proxy (a latency is then refused),
 * or a whole number of milliseconds from 0 to 10000. A race run with no latency keeps the image's
 * default, recorded in its manifest.
 */
export function raceLatency(family: Family, value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!family.proxy) throw new FamilyError(`the ${family.id} family's kit image has no database proxy, so it takes no latency`);
  const text = String(value);
  if (!/^(0|[1-9]\d{0,4})$/.test(text) || Number(text) > MAX_RACE_LATENCY_MS) throw new FamilyError(`the latency must be a whole number of milliseconds from 0 to ${String(MAX_RACE_LATENCY_MS)}`);
  return Number(text);
}

/** Whether the family's probe set records ADM-06 (the partial and stub probes) as not applicable. */
export function adm06For(probes: ProbeSet): Adm06Applicability {
  return probes.data.adm_06 === undefined ? "required" : "not_applicable";
}

/** The family's record of ADM-06 and its admission copy count, for the run summary. */
export function familyRecord(family: Family, probes: ProbeSet): { id: FamilyId; adm06: { status: Adm06Applicability; reason: string | null }; admission_copies: number } {
  const adm06 = adm06For(probes);
  return { id: family.id, adm06: { status: adm06, reason: probes.data.adm_06?.reason ?? null }, admission_copies: adm06 === "required" ? 13 : 11 };
}

/** Refuses a probe set that is not the family's own shape: the selected family's probes must match its fixture. */
export function checkFamilyProbes(family: Family, probes: ProbeSet): void {
  const vectors = family.loadFixture().outcome_vectors;
  const states = Object.keys(vectors).sort().join(",");
  const expected = adm06For(probes) === "required" ? "clean,fixed,partial,planted,stub" : "clean,fixed,planted";
  if (states !== expected) throw new FamilyError(`the ${family.id} fixture declares the code states ${states}, but its probe set needs ${expected}`);
}

const dataName = (family: Family): string => basename(fileURLToPath(family.fixtureFile));

/**
 * Refuses a kit stage whose umami-fixture slot holds another family's fixture data file, or,
 * for a family other than the default, does not hold its own (byte for byte). The default
 * family's check is only the first, so a time-zone run accepts every kit stage it accepted before.
 */
export function checkKitStage(family: Family, kitStage: string): void {
  const dataDir = join(kitStage, "umami-fixture", "data");
  for (const other of Object.values(FAMILIES)) {
    if (other.id !== family.id && existsSync(join(dataDir, dataName(other)))) throw new FamilyError(`the kit stage holds the ${other.id} fixture (${dataName(other)}), not the ${family.id} fixture`);
  }
  const name = dataName(family);
  const path = join(dataDir, name);
  if (!existsSync(path)) {
    if (family.id === DEFAULT_FAMILY) return;
    throw new FamilyError(`the kit stage holds no ${name}: stage the ${family.id} fixture with stage-kit.ts --fixture-package`);
  }
  if (sha256Hex(readFileSync(path)) !== sha256Hex(readFileSync(family.fixtureFile))) throw new FamilyError(`the kit stage's ${name} differs from the ${family.id} fixture's data file`);
}

/**
 * Refuses a kit image built for another family, by the schema of its image manifest: one that
 * names another family's schema, or, for a family other than the default, one that does not name
 * its own. The default family's check is only the first, so a time-zone run accepts every image
 * it accepted before.
 */
export function checkFamilyImage(family: Family, imageManifest: Buffer): void {
  let schema: unknown = null;
  try {
    const parsed: unknown = JSON.parse(imageManifest.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "schema" in parsed) schema = parsed.schema;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const other = Object.values(FAMILIES).find((item) => item.id !== family.id && item.imageSchema === schema);
  if (other !== undefined) throw new FamilyError(`the image is a ${other.id} kit image (${other.imageSchema}), but the ${family.id} family needs ${family.imageSchema}`);
  if (family.id !== DEFAULT_FAMILY && schema !== family.imageSchema) {
    throw new FamilyError(`the ${family.id} family needs a kit image with manifest schema ${family.imageSchema}, but the image has ${typeof schema === "string" ? schema : "none"}`);
  }
}
