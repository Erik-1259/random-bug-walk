// Deterministic gzip-compressed tar archives of regular files. Compression uses one pinned pure-JavaScript
// deflate (fflate) with fixed options and a fixed gzip header, so the same members give the same bytes on
// every platform; decompression uses Node's zlib with an output limit.
import { gunzipSync } from "node:zlib";
import { gzipSync } from "fflate";
import { packTar, readTar, TarError } from "./tar.ts";

export interface ArchiveMember {
  path: string;
  bytes: Uint8Array;
}

export interface UnpackLimits {
  /** The largest uncompressed tar size accepted. */
  maxBytes: number;
  /** The most members accepted. */
  maxMembers: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = { maxBytes: 1024 * 1024 * 1024, maxMembers: 200_000 };

/** Raised for members the writer refuses or bytes the reader refuses. Messages name no member content. */
export class ArchiveError extends Error {
  constructor(reason: string) {
    super(`archive: ${reason}`);
    this.name = "ArchiveError";
  }
}

const encoder = new TextEncoder();

/**
 * A relative POSIX path as the contract's RelativePath defines it: segments joined by "/", no leading or
 * trailing "/", no empty, "." or ".." segment, no backslash and no control character.
 */
export function isRelativePath(path: string): boolean {
  if (path === "" || !path.isWellFormed()) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Orders paths by their UTF-8 bytes, the order every archive and file list uses. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(encoder.encode(a), encoder.encode(b));
}

/** Checks paths, duplicates and paths that collide on a case-insensitive file system. */
function checkMembers(paths: readonly string[]): void {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const path of paths) {
    if (!isRelativePath(path)) throw new ArchiveError("a member path is not a relative path");
    if (exact.has(path)) throw new ArchiveError("a member path appears twice");
    const key = path.toLowerCase();
    if (folded.has(key)) throw new ArchiveError("two member paths differ only in case");
    exact.add(path);
    folded.add(key);
  }
}

/** Fixed deflate options: level 6, memory level 8, mtime 0 and no file name in the gzip header. */
export function gzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes, { level: 6, mem: 8, mtime: 0 });
}

export function gunzip(bytes: Uint8Array, maxBytes: number): Uint8Array {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError) throw new ArchiveError("archive unpacks to more than the limit");
    throw new ArchiveError("archive is not valid gzip data");
  }
}

/** Packs members, sorted by UTF-8 path, into a gzip-compressed tar archive with fixed metadata. */
export function packArchive(members: readonly ArchiveMember[]): Uint8Array {
  checkMembers(members.map((member) => member.path));
  const sorted = [...members].sort((a, b) => compareUtf8(a.path, b.path));
  return gzip(packTar(sorted.map((member) => ({ kind: "file" as const, path: member.path, bytes: member.bytes }))));
}

/** Unpacks an archive into its members, in archive order, refusing anything but checked regular files. */
export function unpackArchive(bytes: Uint8Array, limits: UnpackLimits = DEFAULT_UNPACK_LIMITS): ArchiveMember[] {
  const tar = gunzip(bytes, limits.maxBytes);
  let members: ArchiveMember[];
  try {
    members = readTar(tar);
  } catch (error) {
    if (error instanceof TarError) throw new ArchiveError(error.message);
    throw error;
  }
  if (members.length > limits.maxMembers) throw new ArchiveError("archive has more members than the limit");
  checkMembers(members.map((member) => member.path));
  return members;
}
