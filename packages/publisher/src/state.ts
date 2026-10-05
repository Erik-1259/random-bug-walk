import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CanonicalError,
  RecordError,
  encodeCanonical,
  parseCanonical,
  parseRecord,
  sha256Hex,
  type PublicationRecord,
} from "@rbw/schema";
import type { Limits } from "./config.ts";
import { MANIFEST_FILE, describeCandidate, filesMatchManifest, type Candidate, type FrozenCandidate, type FrozenFile } from "./freeze.ts";

export interface StoredLimits {
  limits: Limits;
  used: Limits;
  counted?: string[];
}

/**
 * The private state directory:
 *
 *   roots/<root>/current                      publication ID of the current candidate
 *   roots/<root>/limits.json                  limits and usage, persisted across retries
 *   roots/<root>/candidates/<id>/manifest.json
 *   roots/<root>/candidates/<id>/files.json   frozen file list
 *   roots/<root>/candidates/<id>/blobs/<sha256>
 *   roots/<root>/candidates/<id>/record.json  the latest PublicationRecord
 *   repository.git                            the publisher's own bare repository
 */
export class StateDir {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get repositoryDir(): string {
    return join(this.dir, "repository.git");
  }

  private rootDir(root: string): string {
    return join(this.dir, "roots", root);
  }

  private candidateDir(root: string, publicationId: string): string {
    return join(this.rootDir(root), "candidates", publicationId);
  }

  /** Writes a file atomically with owner-only permissions. */
  private write(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  currentPublicationId(root: string): string | null {
    const path = join(this.rootDir(root), "current");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  saveCandidate(root: string, frozen: FrozenCandidate): void {
    const { candidate, blobs } = frozen;
    const dir = this.candidateDir(root, candidate.publicationId);
    for (const [sha256, bytes] of blobs) this.write(join(dir, "blobs", sha256), bytes);
    this.write(join(dir, MANIFEST_FILE), candidate.manifestBytes);
    this.write(join(dir, "files.json"), encodeCanonical(candidate.files));
  }

  setCurrent(root: string, publicationId: string): void {
    this.write(join(this.rootDir(root), "current"), new TextEncoder().encode(publicationId));
  }

  /** Loads a frozen candidate, or null when its files are missing or no longer match its manifest. */
  loadCandidate(root: string, publicationId: string): Candidate | null {
    const dir = this.candidateDir(root, publicationId);
    try {
      const manifestBytes = readFileSync(join(dir, MANIFEST_FILE));
      const manifest = parseRecord("RunManifest", manifestBytes);
      const files = parseCanonical(readFileSync(join(dir, "files.json"))) as unknown as FrozenFile[];
      if (!Array.isArray(files) || !filesMatchManifest(manifest, files)) return null;
      return describeCandidate(root, manifest, manifestBytes, sha256Hex(manifestBytes), files);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (missing || error instanceof RecordError || error instanceof CanonicalError) return null;
      throw error;
    }
  }

  readBlob(root: string, publicationId: string, sha256: string): Buffer {
    return readFileSync(join(this.candidateDir(root, publicationId), "blobs", sha256));
  }

  saveRecord(record: PublicationRecord): void {
    this.write(join(this.candidateDir(record.root_execution_id, record.publication_id), "record.json"), encodeCanonical(record));
  }

  loadRecord(root: string, publicationId: string): PublicationRecord {
    return parseRecord("PublicationRecord", readFileSync(join(this.candidateDir(root, publicationId), "record.json")));
  }

  loadLimits(root: string): StoredLimits | null {
    const path = join(this.rootDir(root), "limits.json");
    return existsSync(path) ? (parseCanonical(readFileSync(path)) as unknown as StoredLimits) : null;
  }

  saveLimits(root: string, value: StoredLimits): void {
    this.write(join(this.rootDir(root), "limits.json"), encodeCanonical(value));
  }

  /** Root IDs with a current candidate, sorted. */
  roots(): string[] {
    const dir = join(this.dir, "roots");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((root) => this.currentPublicationId(root) !== null)
      .sort();
  }
}
