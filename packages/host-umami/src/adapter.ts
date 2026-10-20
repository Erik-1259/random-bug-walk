// The Umami HostAdapter: the pinned baseline, the one-entry catalog, its protocol and calendar
// window, the package inputs from the prepared store, the copy plans, the collection of each
// copy's results and the interpretation of copy records.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "@rbw/schema";
import type { BugCaseInputs, CatalogEntry, HostAdapter, HostAvailability, ValidatorInputs } from "@rbw/factory-contract";
import { calendarAvailability } from "./availability.ts";
import { baselineIdentity, buildCatalogEntry } from "./catalog.ts";
import { copyPlans } from "./copy-plans.ts";
import { UmamiRefusal } from "./errors.ts";
import { bugCaseInputs, validatorInputs } from "./inputs.ts";
import type { InputOptions } from "./inputs.ts";
import { interpret } from "./interpret.ts";
import { UMAMI_PINS } from "./pins.ts";
import type { UmamiPins } from "./pins.ts";
import { UMAMI_PROTOCOL } from "./protocol.ts";
import { collectCopy } from "./records.ts";

export interface UmamiAdapterOptions {
  /** The prepared store's directory (see the README's "Prepared store"); without it bugCaseInputs and validatorInputs refuse. */
  store?: string | null;
  /** Makes a new, empty directory for each tree handed out. Default: a fresh directory under the system's temporary directory. */
  newDir?: () => Promise<string>;
}

export interface UmamiAdapter extends HostAdapter {
  host_id: "umami";
  availability(entry: CatalogEntry, from: string, until: string): HostAvailability;
}

const defaultNewDir = (): Promise<string> => mkdtemp(join(tmpdir(), "rbw-host-umami-"));

/** The adapter over any pins; `createUmamiAdapter` uses the real ones, tests use synthetic ones. */
export function buildUmamiAdapter(pins: UmamiPins, options: UmamiAdapterOptions = {}): UmamiAdapter {
  const entry = buildCatalogEntry(pins);
  const entrySha256 = canonicalDigest(entry).sha256;
  const known = (candidate: CatalogEntry): CatalogEntry => {
    if (canonicalDigest(candidate).sha256 !== entrySha256) throw new UmamiRefusal("unknown_entry", `${candidate.entry_id} is not an entry of the Umami catalog`);
    return entry;
  };
  const inputOptions: InputOptions = { store: options.store ?? null, newDir: options.newDir ?? defaultNewDir };
  return {
    host_id: "umami",
    baseline: () => baselineIdentity(pins),
    catalog: () => [structuredClone(entry)],
    protocol: (candidate) => {
      known(candidate);
      return structuredClone(UMAMI_PROTOCOL);
    },
    availability: (candidate, from, until) => {
      known(candidate);
      return calendarAvailability(from, until);
    },
    async bugCaseInputs(candidate): Promise<BugCaseInputs> {
      const inputs = await bugCaseInputs(pins, known(candidate), inputOptions);
      return inputs;
    },
    async validatorInputs(candidate): Promise<ValidatorInputs> {
      const inputs = await validatorInputs(pins, known(candidate), inputOptions);
      return inputs;
    },
    copyPlans: (state, unpacked, protocol) => copyPlans(pins, [entry], state, unpacked, protocol),
    // A refusal becomes a rejection, as for the other promise-returning methods.
    collect: (plan, collected) => Promise.resolve().then(() => collectCopy(pins, plan, collected)),
    interpret: (records, protocol) => interpret(records, protocol),
  };
}

/** The Umami adapter with the pinned image, suite, catalog entry and released incident. */
export function createUmamiAdapter(options: UmamiAdapterOptions = {}): UmamiAdapter {
  return buildUmamiAdapter(UMAMI_PINS, options);
}
