// Validation runs in live mode. A start reads the delivered case's recorded evidence (its host and its
// two parts' hashes), the protocol from the validator core's manifest in the prepared packages (its
// copies price the run's reservation) and the harness identity, then calls the worker's validation
// launch, which takes the slot under the validation root, reserves on the request budget, records the
// run and launches it, or refuses with nothing recorded.
import { VALIDATOR_MANIFEST } from "@rbw/case-package/format";
import { HARNESS_IDENTITY } from "@rbw/case-validate/version";
import { startFactoryValidation, validationRunView } from "@rbw/controller/factory-web";
import type { FactoryDatabase, FactoryLaunchDeps } from "@rbw/controller/factory-web";
import type { ValidationRun } from "@rbw/factory-contract";
import type { StartValidationResult } from "../ports.ts";
import { caseEntry } from "./packages.ts";
import type { PreparedPackages } from "./packages.ts";
import { packageTools } from "./tools.ts";

export async function startValidation(deps: FactoryLaunchDeps, prepared: PreparedPackages, args: { request_id: string; case_id: string; validation_id: string }): Promise<StartValidationResult> {
  const evidence = await deps.records.readEvidence(args.request_id, args.case_id);
  if (evidence === null) return { kind: "unavailable", message: "The case's evidence is not recorded." };
  const entry = caseEntry(prepared, evidence);
  if (entry === null) return { kind: "unavailable", message: "The case's packages are not installed on this service." };
  const { parseValidatorManifest, readPreparedObject, unpackArchive } = await packageTools();
  const manifest = unpackArchive(await readPreparedObject(prepared.dir, entry.validator_core_sha256)).find((member) => member.path === VALIDATOR_MANIFEST);
  if (manifest === undefined) throw new Error("the prepared validator core has no manifest");
  const { packages } = evidence.case;
  return startFactoryValidation(deps, {
    ...args,
    host_id: evidence.case.host_id,
    package_sha256: { bug_case: packages.bug_case.sha256, validator: packages.validator.sha256 },
    harness: HARNESS_IDENTITY,
    protocol: parseValidatorManifest(manifest.bytes).protocol,
  });
}

/** The run, when it belongs to this request and case. */
export async function getValidation(db: FactoryDatabase, requestId: string, caseId: string, validationId: string): Promise<ValidationRun | null> {
  const record = await db.factoryRecords.validation(validationId);
  if (record?.request_id !== requestId || record.case_id !== caseId) return null;
  return validationRunView(record, await db.factoryRecords.validationEvents(validationId));
}
