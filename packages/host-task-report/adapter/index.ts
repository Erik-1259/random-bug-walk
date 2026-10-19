// @rbw/host-task-report/adapter: the task-report host's factory adapter on evaluator v2.
export { AdapterError, createTaskReportAdapter, taskReportAdapter } from "./adapter.ts";
export type { TaskReportAdapter, TaskReportAdapterOptions } from "./adapter.ts";
export { CHECK_PACKAGE_ENTRY, CHECK_PACKAGE_FILES, checkPackageListing, checkSetSha256 } from "./check-package.ts";
export { COPY_COMMAND, COPY_DESTINATIONS, COPY_LIMITS, KIT_IMAGE_FILE, KitImageError, loadKitImage, parseKitImage } from "./kit.ts";
export type { KitImagePin } from "./kit.ts";
export type { CatalogEntry, CollectedCopy, CopyDestinations, CopyPlan, CopyRoots, CopyRunner, HostAdapter } from "./contract.ts";
export { EXPECTED_CELLS, aggregateState, evaluateCopyV2, evaluateProtocolV2, overallVerdict, perStateV2, replayBlock, stateVerdict } from "../v2/evaluate.ts";
export type { CopyEvaluation, ProtocolEvaluationV2, StateEvaluationV2 } from "../v2/evaluate.ts";
export { loadProtocolV2, PROTOCOL_V2_FILE } from "../v2/protocol.ts";
export type { ProtocolV2 } from "../v2/protocol.ts";
