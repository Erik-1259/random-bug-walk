// A small POSIX ustar codec with fixed metadata, so archive bytes depend on paths and contents only.
// The writer emits regular files; result trees add symbolic links and copy placement adds directories,
// but package archives never hold either. A path that does not fit the ustar name and prefix fields gets
// a PAX `path` record. The reader accepts only regular files and refuses everything else.

const BLOCK = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;
/** The largest size the 11 octal digits of the size field hold. */
const MAX_SIZE = 0o77777777777;
const SLASH = 0x2f;

/** Directory entries exist only for placing files into a copy (a runner pre-creates its results directory). */
export type TarEntry =
  | { kind: "file"; path: string; bytes: Uint8Array }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "directory"; path: string; mode: number };

export interface TarFile {
  path: string;
  bytes: Uint8Array;
}

/** Raised for an entry the writer cannot encode or an archive the reader refuses. Messages never quote content. */
export class TarError extends Error {
  constructor(reason: string) {
    super(`tar: ${reason}`);
    this.name = "TarError";
  }
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) throw new TarError("number too large for its field");
  header.set(encoder.encode(digits), offset);
  header[offset + length - 1] = 0;
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  return sum;
}

/** Splits a UTF-8 path at a slash into a ustar prefix and name, or answers null when no split fits. */
function splitPath(path: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | null {
  if (path.length <= NAME_LENGTH) return { prefix: new Uint8Array(0), name: path };
  for (let index = Math.min(PREFIX_LENGTH, path.length - 2); index > 0; index -= 1) {
    if (path[index] !== SLASH) continue;
    const nameLength = path.length - index - 1;
    if (nameLength > NAME_LENGTH) break;
    return { prefix: path.subarray(0, index), name: path.subarray(index + 1) };
  }
  return null;
}

/** Cuts UTF-8 bytes to at most `length` bytes without splitting a character. */
function cut(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length <= length) return bytes;
  let end = length;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function header(fields: { name: Uint8Array; prefix: Uint8Array; mode: number; size: number; typeflag: string; linkname: Uint8Array }): Uint8Array {
  if (fields.size > MAX_SIZE) throw new TarError("entry too large");
  const block = new Uint8Array(BLOCK);
  block.set(fields.name, 0);
  writeOctal(block, 100, 8, fields.mode);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, fields.size);
  writeOctal(block, 136, 12, 0); // mtime
  block[156] = fields.typeflag.charCodeAt(0);
  block.set(fields.linkname, 157);
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);
  // uname and gname stay empty.
  writeOctal(block, 329, 8, 0); // devmajor
  writeOctal(block, 337, 8, 0); // devminor
  block.set(fields.prefix, 345);
  const sum = checksum(block);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

function paxRecord(key: string, value: Uint8Array): Uint8Array {
  const body = encoder.encode(` ${key}=`);
  const base = body.length + value.length + 1;
  let length = base + String(base).length;
  if (String(length).length !== String(base).length) length = base + String(length).length;
  const record = new Uint8Array(length);
  record.set(encoder.encode(String(length)), 0);
  record.set(body, String(length).length);
  record.set(value, String(length).length + body.length);
  record[length - 1] = 0x0a;
  return record;
}

function padded(bytes: Uint8Array): Uint8Array[] {
  const remainder = bytes.length % BLOCK;
  return remainder === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - remainder)];
}

/** Packs entries in the given order with mode 0644 (links 0777), owner 0, mtime 0 and empty user names. */
export function packTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const path = encoder.encode(entry.kind === "directory" ? `${entry.path}/` : entry.path);
    const link = entry.kind === "symlink" ? encoder.encode(entry.target) : new Uint8Array(0);
    const split = splitPath(path);
    const records: Uint8Array[] = [];
    if (split === null) records.push(paxRecord("path", path));
    if (link.length > NAME_LENGTH) records.push(paxRecord("linkpath", link));
    if (records.length > 0) {
      const body = new Uint8Array(records.reduce((total, record) => total + record.length, 0));
      let offset = 0;
      for (const record of records) {
        body.set(record, offset);
        offset += record.length;
      }
      parts.push(header({ name: encoder.encode("pax"), prefix: new Uint8Array(0), mode: 0o644, size: body.length, typeflag: "x", linkname: new Uint8Array(0) }));
      parts.push(...padded(body));
    }
    const names = split ?? { prefix: new Uint8Array(0), name: cut(path, NAME_LENGTH) };
    if (entry.kind === "file") {
      parts.push(header({ ...names, mode: 0o644, size: entry.bytes.length, typeflag: "0", linkname: new Uint8Array(0) }));
      parts.push(...padded(entry.bytes));
    } else if (entry.kind === "directory") {
      parts.push(header({ ...names, mode: entry.mode, size: 0, typeflag: "5", linkname: new Uint8Array(0) }));
    } else {
      parts.push(header({ ...names, mode: 0o777, size: 0, typeflag: "2", linkname: cut(link, NAME_LENGTH) }));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function isZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  try {
    return strictDecoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
  } catch {
    throw new TarError("entry name is not UTF-8");
  }
}

function octal(bytes: Uint8Array): number {
  const digits = text(bytes).replace(/[ ]+$/, "");
  if (!/^[0-7]{1,11}$/.test(digits)) throw new TarError("malformed number field");
  return Number.parseInt(digits, 8);
}

function parsePax(body: Uint8Array): string {
  let offset = 0;
  let path: string | null = null;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new TarError("malformed PAX record");
    const lengthText = text(body.subarray(offset, space));
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new TarError("malformed PAX record");
    const length = Number(lengthText);
    const end = offset + length;
    if (end > body.length || body[end - 1] !== 0x0a) throw new TarError("malformed PAX record");
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 0) throw new TarError("malformed PAX record");
    const key = text(record.subarray(0, equals));
    if (key !== "path" || path !== null) throw new TarError("unsupported PAX record");
    try {
      path = strictDecoder.decode(record.subarray(equals + 1));
    } catch {
      throw new TarError("PAX path is not UTF-8");
    }
    offset = end;
  }
  if (path === null) throw new TarError("PAX header without a path");
  return path;
}

/**
 * Reads the regular files of an archive in order. Refuses links, directories, devices, global or GNU
 * headers, PAX records other than `path`, bad checksums, truncation and data after the end marker.
 */
export function readTar(bytes: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  let offset = 0;
  let paxPath: string | null = null;
  for (;;) {
    if (offset + BLOCK > bytes.length) throw new TarError("archive is truncated");
    const block = bytes.subarray(offset, offset + BLOCK);
    if (isZero(block)) {
      if (paxPath !== null) throw new TarError("PAX header without an entry");
      if (offset + 2 * BLOCK > bytes.length || !isZero(bytes.subarray(offset + BLOCK, offset + 2 * BLOCK))) {
        throw new TarError("archive is truncated");
      }
      if (!isZero(bytes.subarray(offset + 2 * BLOCK))) throw new TarError("data after the end of the archive");
      return files;
    }
    if (octal(block.subarray(148, 156)) !== checksum(block)) throw new TarError("header checksum mismatch");
    if (text(block.subarray(257, 263)) !== "ustar" || block[263] !== 0x30 || block[264] !== 0x30) throw new TarError("not a ustar header");
    const size = octal(block.subarray(124, 136));
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new TarError("archive is truncated");
    const typeflag = block[156];
    const data = bytes.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === 0x78) {
      if (paxPath !== null) throw new TarError("consecutive PAX headers");
      paxPath = parsePax(data);
      continue;
    }
    if (typeflag !== 0x30 && typeflag !== 0) throw new TarError("entry is not a regular file");
    const name = text(block.subarray(0, 100));
    const prefix = text(block.subarray(345, 500));
    const path = paxPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    paxPath = null;
    files.push({ path, bytes: data.slice() });
  }
}
