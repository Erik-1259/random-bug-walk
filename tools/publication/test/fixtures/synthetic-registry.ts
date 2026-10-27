// The registry and identity modules for the prepare-scan-hook end-to-end test: one synthetic task-report
// entry, whose input files are written under SYNTHETIC_PREPARE_WORKDIR.
import { SYNTHETIC_LICENSE, syntheticAdapter, syntheticIdentity } from "@rbw/case-package/synthetic";

const workdir = process.env.SYNTHETIC_PREPARE_WORKDIR;
if (workdir === undefined || workdir === "") throw new Error("SYNTHETIC_PREPARE_WORKDIR is not set");
const adapter = syntheticAdapter({ seeds: ["01"], workdir });

export const HOST_REGISTRY = { list: () => [{ host_id: "task-report", license: SYNTHETIC_LICENSE, adapter }] };
export const CASE_IDENTITY = syntheticIdentity;
