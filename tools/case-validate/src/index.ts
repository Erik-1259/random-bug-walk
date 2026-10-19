// Node entry of the harness. Web routes import ./registry and ./version, which import no runner.
export { dockerRunner, UNRESOLVED_IMAGE_DIGEST } from "./docker.ts";
export type { CommandOptions, CommandResult, DockerCommand, DockerRunnerOptions } from "./docker.ts";
export { evaluateMatrix } from "./matrix.ts";
export type { CellMatrix } from "./matrix.ts";
export { createHostRegistry, HOST_REGISTRY, RegistryError } from "./registry.ts";
export type { HostRegistration, HostRegistry } from "./registry.ts";
export { EXIT_CODES, runValidateCli, USAGE } from "./run-cli.ts";
export type { CliDependencies, Io } from "./run-cli.ts";
export { CopyLoopError, runCopies, validatePair } from "./validate.ts";
export type { CopyLoopInput, CopyLoopOutcome, ValidatePairErrorCode, ValidatePairInput, ValidatePairResult } from "./validate.ts";
export { PairRefused, verifyPair } from "./verify.ts";
export type { VerifiedPair, VerifiedPart } from "./verify.ts";
export { HARNESS_IDENTITY, HARNESS_VERSION } from "./version.ts";
export { buildWorkspace } from "./workspace.ts";
export type { Workspace } from "./workspace.ts";
export { resultsSha256, resultsTar } from "@rbw/case-package";
