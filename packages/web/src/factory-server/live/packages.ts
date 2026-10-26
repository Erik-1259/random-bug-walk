// A delivered case's two parts in live mode, read from the prepared packages directory as the worker
// built them: the bug case is the prepared object its package_ready event names, and the validator is
// the prepared validator core with the case's recorded qualification record as its evidence member,
// assembled again (the assembly is deterministic, so these are the bytes the worker hashed). The
// download handler checks the size and SHA-256 against the case before any byte is sent.
import { Readable } from "node:stream";
import { assembleFinalValidator } from "@rbw/case-package/assembly";
import type { PreparedEntry, PreparedIndex } from "@rbw/case-package/format";
import type { FactoryDatabase } from "@rbw/controller/factory-web";
import type { CaseEvidence } from "@rbw/factory";
import type { PackageRead } from "../ports.ts";
import { packageTools } from "./tools.ts";

/** The prepared packages directory and its index, as the server read it. */
export interface PreparedPackages {
  dir: string;
  index: PreparedIndex;
}

/** The prepared entry of a delivered case, by its case ID and host. */
export function caseEntry(prepared: PreparedPackages, evidence: CaseEvidence): PreparedEntry | null {
  return prepared.index.entries.find((entry) => entry.case_id === evidence.case.case_id && entry.host_id === evidence.case.host_id) ?? null;
}

/** The SHA-256 the case's package_ready event recorded for each part; null before that event. */
async function readyHashes(db: FactoryDatabase, requestId: string, caseId: string): Promise<{ bug_case: string; validator: string } | null> {
  const events = await db.factoryRecords.events(requestId);
  const ready = events.find((event) => event.type === "package_ready" && event.case_id === caseId);
  if (ready === undefined) return null;
  const { bug_case_sha256: bugCase, validator_sha256: validator } = ready.data;
  if (typeof bugCase !== "string" || typeof validator !== "string") throw new Error("the package_ready event names no part hashes");
  return { bug_case: bugCase, validator };
}

/** A part of a case of the request, or null when the request has no evidence or package_ready for it. */
export async function readPackage(db: FactoryDatabase, prepared: PreparedPackages, requestId: string, caseId: string, part: "bug-case" | "validator"): Promise<PackageRead | null> {
  const evidence = await db.factoryRecords.readEvidence(requestId, caseId);
  if (evidence === null) return null;
  const hashes = await readyHashes(db, requestId, caseId);
  if (hashes === null) return null;
  const { readPreparedObject } = await packageTools();
  let bytes: Uint8Array;
  let sha256: string;
  if (part === "bug-case") {
    sha256 = hashes.bug_case;
    bytes = await readPreparedObject(prepared.dir, sha256);
  } else {
    const entry = caseEntry(prepared, evidence);
    if (entry === null) throw new Error("the prepared packages hold no entry for the delivered case");
    sha256 = hashes.validator;
    bytes = assembleFinalValidator(await readPreparedObject(prepared.dir, entry.validator_core_sha256), evidence.record);
  }
  const filename = part === "bug-case" ? evidence.case.packages.bug_case.filename : evidence.case.packages.validator.filename;
  return { filename, sha256, size: bytes.length, body: Readable.from([bytes]) };
}
