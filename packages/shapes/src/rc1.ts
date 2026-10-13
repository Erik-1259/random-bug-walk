// Data for shape RC-1.atomic-backup-code: the pinned target, the upstream source fix and the rule
// files. The expected hashes live here, not in caller input, so a caller cannot widen what is
// confirmed. The mutation is one line in the 2FA verify route: the backup-code updateMany loses
// its `used: false` guard, so two concurrent requests can both spend one code.
import { fileURLToPath } from "node:url";
import type { BlobSpec } from "./shape.ts";

export const RC1_SHAPE_ID = "RC-1.atomic-backup-code";

/**
 * The source fix (upstream 3e165a8c) and the target are the same handler in Umami, through the
 * same Prisma API. The mutation reverts only the fix's `used: false` guard; it keeps the fix's
 * updateMany and its `consumed.count === 0` branch, which the planted code can no longer reach.
 */
export const RC1_FIDELITY = { label: "partial_reversion", tier: "A" } as const;

export const RC1_RULE_FILE = fileURLToPath(new URL("../rules/rc-1.atomic-backup-code.yml", import.meta.url));
export const RC1_SOURCE_RULE_FILE = fileURLToPath(new URL("../rules/rc-1.atomic-backup-code.source.yml", import.meta.url));
export const RC1_PROBE_DIR = fileURLToPath(new URL("../probes/rc-1.atomic-backup-code/", import.meta.url));

export const RC1_FIXED_RULE_ID = "rc-1.atomic-backup-code";
export const RC1_PLANTED_RULE_ID = "rc-1.atomic-backup-code.planted";
export const RC1_SOURCE_RULE_ID = "rc-1.atomic-backup-code.source";

/** The one added check the race fixture runs, and the reason it gives when a code is spent twice. */
export const RC1_CHECK_ID = "rc1.backup-code-single-use";
export const RC1_DOUBLE_SPEND_REASON = "double_spend";

export interface Rc1TargetSpec {
  readonly hostCommit: string;
  readonly path: string;
  readonly mode: string;
  readonly gitBlob: string;
  readonly sha256: string;
  readonly resultSha256: string;
  /** The function that must contain the one selected `where` object. */
  readonly functionName: string;
  /** The one line the mutation changes, before and after. */
  readonly line: number;
  readonly cleanLine: string;
  readonly plantedLine: string;
}

export const RC1_TARGET: Rc1TargetSpec = {
  hostCommit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
  path: "src/app/api/2fa/verify/route.ts",
  mode: "100644",
  gitBlob: "421cf27b20cb53d37ef58006eaf1ff32e5d97370",
  sha256: "3e766a0ba16e2547c234442176c04a0f2fd096d033a7079d21938dd9796acb87",
  resultSha256: "30426f040a2c4ea1730827644b8947feed39dc8f2487fec1372139f5be9d66fb",
  functionName: "POST",
  line: 97,
  cleanLine: "      where: { id: unusedCodes[matchIndex].id, used: false },",
  plantedLine: "      where: { id: unusedCodes[matchIndex].id },",
};

export interface Rc1SourceSpec {
  readonly commit: string;
  readonly parent: string;
  readonly path: string;
  readonly functionName: string;
  /** The Prisma method the anchor rule finds on each side of the fix. */
  readonly beforeMethod: string;
  readonly afterMethod: string;
  readonly before: BlobSpec;
  readonly after: BlobSpec;
}

/** Upstream 3e165a8c, "fix(2FA): backup code double-use race condition", with its only parent. */
export const RC1_SOURCE: Rc1SourceSpec = {
  commit: "3e165a8c6fea303250e626dc952a396e40887c71",
  parent: "b4bb9cc727cd0ec05dc233e3e1f506f2e3633e34",
  path: "src/app/api/2fa/verify/route.ts",
  functionName: "POST",
  beforeMethod: "update",
  afterMethod: "updateMany",
  before: {
    gitBlob: "636af3caa3b91327638e8c61c3e4c7c4bf227fc7",
    sha256: "6a6f980349a4f6ce9b66b7053e29fc1149608fd72c776c9feaf52eb2535369dd",
  },
  after: {
    gitBlob: "eea621b2b464098149e60bfb7b9397ebca2ad9ff",
    sha256: "e2f3bb37bbb2e12ad46a6974d13216e61a41e4babc344a55e07a723ebd223b01",
  },
};
