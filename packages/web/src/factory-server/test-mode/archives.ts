// Synthetic package parts for test mode: a deterministic gzip-compressed tar holding one text file
// that says what it is. The validator part also carries a sentinel string that stands for evaluator
// material, so tests can check that no JSON response ever contains it.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { canonicalDigest } from "@rbw/schema";

export const TEST_MODE_EVALUATOR_SENTINEL = "synthetic-test-mode-evaluator-material-5e0b";

export interface Archive {
  bytes: Uint8Array;
  sha256: string;
}

export interface ArchivePair {
  bug_case: Archive;
  validator: Archive;
  pair_sha256: string;
}

const encoder = new TextEncoder();

/** One ustar entry: a 512-byte header (mtime 0, owner 0) and the content padded to 512 bytes. */
function tarEntry(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number): void => {
    header.set(encoder.encode(text), offset);
  };
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = new Uint8Array(Math.ceil(content.length / 512) * 512);
  body.set(content);
  return Buffer.concat([header, body]);
}

function archive(text: string): Archive {
  const tar = Buffer.concat([tarEntry("SYNTHETIC-TEST-MODE.txt", encoder.encode(text)), new Uint8Array(1024)]);
  const bytes = new Uint8Array(gzipSync(tar, { level: 9 }));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function syntheticPair(caseId: string): ArchivePair {
  const bugCase = archive(`Synthetic test-mode bug case for case ${caseId}. It holds no application source.\n`);
  const validator = archive(`Synthetic test-mode validator package for case ${caseId}.\n${TEST_MODE_EVALUATOR_SENTINEL}\n`);
  const pair = canonicalDigest({ case_id: caseId, bug_case_sha256: bugCase.sha256, validator_sha256: validator.sha256 }).sha256;
  return { bug_case: bugCase, validator, pair_sha256: pair };
}
