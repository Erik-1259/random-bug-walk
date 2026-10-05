// Data for shape DT-1.tz-arg: the pinned target, the upstream source fix and the rule files.
// The expected hashes live here, not in caller input, so a caller cannot widen what is confirmed.
import { fileURLToPath } from "node:url";

export const SHAPE_ID = "DT-1.tz-arg";

/** The source fix is in a React date-range hook and the target is a SQL date helper. */
export const FIDELITY = { label: "synthetic_transplant", tier: "B" } as const;

export const RULE_FILE = fileURLToPath(new URL("../rules/dt-1.tz-arg.yml", import.meta.url));
export const SOURCE_RULE_FILE = fileURLToPath(new URL("../rules/dt-1.tz-arg.source.yml", import.meta.url));
export const PROBE_DIR = fileURLToPath(new URL("../probes/dt-1.tz-arg/", import.meta.url));

export const FIXED_RULE_ID = "dt-1.tz-arg";
export const PLANTED_RULE_ID = "dt-1.tz-arg.planted";
export const SOURCE_RULE_ID = "dt-1.tz-arg.source";

export interface TargetSpec {
  readonly hostCommit: string;
  readonly path: string;
  readonly mode: string;
  readonly sha256: string;
  readonly resultSha256: string;
  /** The function that must contain the one selected call. */
  readonly functionName: string;
  /** The parameter of `functionName`, by position, that the timezone must be destructured from. */
  readonly filtersParam: { readonly name: string; readonly index: number };
  readonly routePath: string;
  readonly routeSha256: string;
  /** ast-grep patterns that show the endpoint builds the filters and passes them to the query. */
  readonly routeFiltersPattern: string;
  readonly routeCallPattern: string;
}

export const DT1_TARGET: TargetSpec = {
  hostCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
  path: "src/queries/sql/pageviews/getPageviewStats.ts",
  mode: "100644",
  sha256: "1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b",
  resultSha256: "7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c",
  functionName: "relationalQuery",
  filtersParam: { name: "filters", index: 1 },
  routePath: "src/app/api/websites/[websiteId]/pageviews/route.ts",
  routeSha256: "97a4a56ac175e5a72990e2a81622c53eeb9909bf45deca4e0a9ac358d01ba83d",
  routeFiltersPattern: "const filters = await getQueryFilters(query, websiteId)",
  routeCallPattern: "getPageviewStats(websiteId, filters)",
};

export interface BlobSpec {
  readonly gitBlob: string;
  readonly sha256: string;
}

export interface SourceSpec {
  readonly commit: string;
  readonly parent: string;
  readonly path: string;
  readonly functionName: string;
  readonly callee: string;
  /** The hook whose result binds the argument the fix added. */
  readonly binder: string;
  readonly argument: string;
  readonly before: BlobSpec;
  readonly after: BlobSpec;
}

export const DT1_SOURCE: SourceSpec = {
  commit: "e6f3f3b4b40a490d5cb050471baa0999366dab2a",
  parent: "0a838649b773122cc68cbd0c3df78d4251b981c5",
  path: "src/app/(main)/websites/[websiteId]/(reports)/revenue/RevenuePage.tsx",
  functionName: "RevenuePage",
  callee: "useDateRange",
  binder: "useTimezone",
  argument: "timezone",
  before: {
    gitBlob: "3e429c18784ff43a761291d100d797f963bce6be",
    sha256: "58cc117a5e0977b7150e16a641aafbe0aa5da017089ca847a93643f2dcfc5eb9",
  },
  after: {
    gitBlob: "4dc19e012a0aa9f2a8f410aea79e5e4bad42f043",
    sha256: "605424fab8d92c943ecb085d20af588d67e6185e6fd6c0571bf0ca86abc7c965",
  },
};
