import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ArchiveError, packArchive, unpackArchive } from "../src/archive.ts";
import { packTar, readTar } from "../src/tar.ts";

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function field(header: Uint8Array, offset: number, length: number): string {
  return decode(header.subarray(offset, offset + length)).replace(/\0+$/, "");
}

/** Rewrites one header byte and recomputes the header checksum, so a test can build entries packTar never writes. */
function withTypeflag(tar: Uint8Array, headerOffset: number, typeflag: string): Uint8Array {
  const copy = tar.slice();
  copy[headerOffset + 156] = typeflag.charCodeAt(0);
  copy.fill(0x20, headerOffset + 148, headerOffset + 156);
  let sum = 0;
  for (let index = headerOffset; index < headerOffset + 512; index += 1) sum += copy[index] ?? 0;
  copy.set(text(`${sum.toString(8).padStart(6, "0")}\0 `), headerOffset + 148);
  return copy;
}

describe("packArchive", () => {
  it("round-trips the members and returns them in UTF-8 byte order", () => {
    const members = [
      { path: "source/b.ts", bytes: text("b\n") },
      { path: "bug-case.json", bytes: text("{}") },
      { path: "source/a.ts", bytes: text("a\n") },
      { path: "source/Z.ts", bytes: new Uint8Array(0) },
    ];
    const unpacked = unpackArchive(packArchive(members));
    expect(unpacked.map((member) => member.path)).toEqual(["bug-case.json", "source/Z.ts", "source/a.ts", "source/b.ts"]);
    expect(decode(unpacked.find((member) => member.path === "source/b.ts")?.bytes ?? new Uint8Array())).toBe("b\n");
    expect(unpacked.find((member) => member.path === "source/Z.ts")?.bytes.length).toBe(0);
  });

  it("gives the same bytes for the same members in any input order", () => {
    const members = [
      { path: "x/one.txt", bytes: text("1") },
      { path: "x/two.txt", bytes: text("2") },
      { path: "a.json", bytes: text("{}") },
    ];
    const first = packArchive(members);
    const second = packArchive([...members].reverse());
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("writes fixed tar metadata: mode 0644, owner and group 0, mtime 0, no user names, no directory entries", () => {
    const tar = gunzipSync(packArchive([{ path: "dir/file.txt", bytes: text("content") }]));
    const header = tar.subarray(0, 512);
    expect(field(header, 0, 100)).toBe("dir/file.txt");
    expect(field(header, 100, 8)).toBe("0000644");
    expect(field(header, 108, 8)).toBe("0000000");
    expect(field(header, 116, 8)).toBe("0000000");
    expect(field(header, 136, 12)).toBe("00000000000");
    expect(String.fromCharCode(header[156] ?? 0)).toBe("0");
    expect(field(header, 257, 6)).toBe("ustar");
    expect(field(header, 265, 32)).toBe("");
    expect(field(header, 297, 32)).toBe("");
    // One header, one data block, two end-of-archive blocks; nothing else.
    expect(tar.length).toBe(512 * 4);
  });

  it("writes a gzip header with mtime 0, no file name and a fixed OS byte", () => {
    const bytes = packArchive([{ path: "a.txt", bytes: text("a") }]);
    expect([...bytes.subarray(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00]);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(bytes[9]).toBe(3);
  });

  it("keeps paths longer than 100 bytes, with and without a ustar prefix split", () => {
    const split = `${"d".repeat(120)}/${"f".repeat(90)}.ts`;
    const unsplittable = `src/${"n".repeat(150)}.ts`;
    const unicode = `src/${"é".repeat(70)}/file.ts`;
    const unpacked = unpackArchive(packArchive([split, unsplittable, unicode].map((path) => ({ path, bytes: text(path) }))));
    for (const member of unpacked) expect(decode(member.bytes)).toBe(member.path);
    expect(unpacked.map((member) => member.path).sort()).toEqual([split, unsplittable, unicode].sort());
  });

  it("refuses a path that is both a file and the directory of another path, in any letter case", () => {
    expect(() => packArchive([{ path: "source/lib", bytes: text("1") }, { path: "source/lib/x.js", bytes: text("2") }])).toThrow(ArchiveError);
    expect(() => packArchive([{ path: "src/Foo", bytes: text("1") }, { path: "src/foo/bar.ts", bytes: text("2") }])).toThrow(ArchiveError);
    const archive = gzipSync(packTar([
      { kind: "file", path: "source/lib/x.js", bytes: text("2") },
      { kind: "file", path: "source/lib", bytes: text("1") },
    ]));
    expect(() => unpackArchive(archive)).toThrow(ArchiveError);
  });

  it("refuses duplicate, case-colliding and non-relative paths", () => {
    expect(() => packArchive([{ path: "a.txt", bytes: text("1") }, { path: "a.txt", bytes: text("2") }])).toThrow(ArchiveError);
    expect(() => packArchive([{ path: "src/A.ts", bytes: text("1") }, { path: "src/a.ts", bytes: text("2") }])).toThrow(ArchiveError);
    expect(() => packArchive([{ path: "docs/café.md", bytes: text("1") }, { path: "docs/café.md", bytes: text("2") }])).toThrow(ArchiveError);
    expect(() => packArchive([{ path: "straße.md", bytes: text("1") }, { path: "STRASSE.md", bytes: text("2") }])).toThrow(ArchiveError);
    for (const path of ["/abs.txt", "../up.txt", "a/../b.txt", "a//b.txt", "a/./b.txt", "a\\b.txt", "trailing/", "", "ctl\u0001.txt"]) {
      expect(() => packArchive([{ path, bytes: text("x") }]), path).toThrow(ArchiveError);
    }
  });
});

describe("unpackArchive", () => {
  it("refuses absolute and parent-relative entry paths", () => {
    for (const path of ["/etc/passwd", "../escape.txt", "a/../../escape.txt"]) {
      const archive = gzipSync(packTar([{ kind: "file", path, bytes: text("x") }]));
      expect(() => unpackArchive(archive), path).toThrow(ArchiveError);
    }
  });

  it("refuses links, directories and other non-regular entries", () => {
    const link = gzipSync(packTar([{ kind: "symlink", path: "link", target: "/etc/passwd" }]));
    expect(() => unpackArchive(link)).toThrow(ArchiveError);
    const file = packTar([{ kind: "file", path: "dir", bytes: new Uint8Array(0) }]);
    for (const typeflag of ["5", "1", "3", "4", "6", "g", "L"]) {
      expect(() => unpackArchive(gzipSync(withTypeflag(file, 0, typeflag))), typeflag).toThrow(ArchiveError);
    }
  });

  it("refuses duplicate and case-colliding entries in an archive", () => {
    const duplicate = gzipSync(packTar([
      { kind: "file", path: "a.txt", bytes: text("1") },
      { kind: "file", path: "a.txt", bytes: text("2") },
    ]));
    expect(() => unpackArchive(duplicate)).toThrow(ArchiveError);
    const colliding = gzipSync(packTar([
      { kind: "file", path: "README.md", bytes: text("1") },
      { kind: "file", path: "readme.md", bytes: text("2") },
    ]));
    expect(() => unpackArchive(colliding)).toThrow(ArchiveError);
  });

  it("refuses an archive that unpacks to more than its limit", () => {
    const archive = packArchive([{ path: "big.bin", bytes: new Uint8Array(64 * 1024) }]);
    expect(() => unpackArchive(archive, { maxBytes: 16 * 1024, maxMembers: 10 })).toThrow(ArchiveError);
    const many = packArchive(Array.from({ length: 5 }, (_, index) => ({ path: `f${String(index)}`, bytes: text("x") })));
    expect(() => unpackArchive(many, { maxBytes: 1 << 20, maxMembers: 4 })).toThrow(ArchiveError);
  });

  it("refuses a truncated archive, a bad checksum and data that is not gzip", () => {
    const tar = packTar([{ kind: "file", path: "a.txt", bytes: text("abc") }]);
    expect(() => unpackArchive(gzipSync(tar.subarray(0, 1024)))).toThrow(ArchiveError);
    const corrupt = tar.slice();
    corrupt[0] = "b".charCodeAt(0);
    expect(() => unpackArchive(gzipSync(corrupt))).toThrow(ArchiveError);
    expect(() => unpackArchive(tar)).toThrow(ArchiveError);
  });
});

describe("readTar", () => {
  it("reads what packTar writes, including a PAX path", () => {
    const path = `deep/${"p".repeat(200)}`;
    const entries = readTar(packTar([{ kind: "file", path, bytes: text("x") }]));
    expect(entries).toEqual([{ path, bytes: text("x") }]);
  });
});
