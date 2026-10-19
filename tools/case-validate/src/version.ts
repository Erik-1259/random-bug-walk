// The harness identity that QualificationRecord.export_verification.harness and ValidationRun.harness carry.
// No imports with behavior, so web routes can read it.
import type { HarnessIdentity } from "@rbw/factory-contract";

export const HARNESS_VERSION = "1";

export const HARNESS_IDENTITY: HarnessIdentity = { name: "rbw-validate", version: HARNESS_VERSION };
