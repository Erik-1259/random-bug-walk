import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import { CLASS_RULE_FILE, findSites, findSitesInSource, loadClassRules, type SiteRecord } from "../../src/classes.ts";
import { RuleFileError, applyFix, loadRules } from "../../src/rules.ts";

const FIXTURES = fileURLToPath(new URL("fixtures/race/", import.meta.url));
const TREE = join(FIXTURES, "tree");
const RULES = readFileSync(CLASS_RULE_FILE);
const CLASSES = loadClassRules(RULES);
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "shapes-classes-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The synthetic fixtures, stored as `.ts.txt` so the package's own type check skips them. */
function treeFiles(dir = TREE, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? treeFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

function source(file: string): string {
  return readFileSync(join(TREE, `${file}.txt`), "utf8");
}

function expected(name: string): string {
  return readFileSync(join(FIXTURES, "expected", name), "utf8");
}

function sitesIn(file: string): SiteRecord[] {
  return findSitesInSource(CLASSES, file, source(file));
}

/** Copies the fixture tree to a fresh directory as real `.ts` files, plus files the scan must skip. */
function materialize(): string {
  const root = mkdtempSync(join(scratch, "tree-"));
  for (const file of treeFiles()) {
    const target = join(root, file.replace(/\.txt$/, ""));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(TREE, file), target);
  }
  const guarded = source("api/vouchers/redeem.ts");
  mkdirSync(join(root, "node_modules", "vendor"), { recursive: true });
  writeFileSync(join(root, "node_modules", "vendor", "index.ts"), guarded);
  writeFileSync(join(root, "types.d.ts"), guarded);
  writeFileSync(join(root, "notes.md"), guarded);
  return root;
}

describe("class rule file", () => {
  it("pairs each fixed-form rule with its planted-form rule under one class ID", () => {
    expect(CLASSES.map((rule) => [rule.classId, rule.fixed.id, rule.planted.id])).toEqual([
      ["RACE.guarded-write", "race.guarded-write", "race.guarded-write.planted"],
      ["RACE.check-then-act", "race.upsert", "race.upsert.planted"],
    ]);
  });

  it("names no host file, function or model, so it matches by structure alone", () => {
    const text = RULES.toString("utf8");
    expect(text).not.toMatch(/umami|website|session|prisma|getDateSQL/i);
  });

  it("refuses a class rule without a planted rule or without a shared class ID", () => {
    expect(() => loadClassRules(Buffer.from("id: a\nlanguage: TypeScript\nrule: {pattern: f($X)}\nfix: g($X)\nmetadata: {class_id: C}\n"))).toThrow(
      RuleFileError,
    );
    expect(() =>
      loadClassRules(
        Buffer.from(
          "id: a\nlanguage: TypeScript\nrule: {pattern: f($X)}\nfix: g($X)\nmetadata: {class_id: C}\n---\nid: a.planted\nlanguage: TypeScript\nrule: {pattern: g($X)}\nmetadata: {class_id: D}\n",
        ),
      ),
    ).toThrow(RuleFileError);
    expect(() => loadClassRules(Buffer.from("id: a\nlanguage: TypeScript\nrule: {pattern: f($X)}\n"))).toThrow(RuleFileError);
  });
});

describe("find sites in one file", () => {
  it("finds the guarded write after an awaited read and plants by dropping only the guard", () => {
    const sites = sitesIn("api/vouchers/redeem.ts");
    expect(sites.map((site) => [site.rule_id, site.line, site.column, site.function, site.matched])).toEqual([
      ["race.guarded-write", 17, 38, "POST", "redeemed: false"],
    ]);
    const [site] = sites;
    expect(applyPatch(source("api/vouchers/redeem.ts"), site?.diff ?? "")).toBe(expected("redeem.planted.ts.txt"));
    expect(site?.diff).toContain("--- a/api/vouchers/redeem.ts\n+++ b/api/vouchers/redeem.ts\n");
    expect(site?.planted_form_confirmed).toBe(true);
    expect(site?.confidence).toEqual({
      score: 1,
      level: "high",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: true, identity_from_read: true, await_between: true },
    });
  });

  it("leaves a write alone when the function never reads that model", () => {
    // The ledger write in the same handler has a guard but no read of `ledger` before it.
    expect(sitesIn("api/vouchers/redeem.ts").some((site) => site.diff.includes("settled"))).toBe(false);
  });

  it("handles a multi-line where inside a transaction callback, counting a guard the code tests", () => {
    const sites = sitesIn("api/seats/hold.ts");
    expect(sites.map((site) => [site.line, site.function, site.matched])).toEqual([[13, "holdSeat", "status: 'open'"]]);
    expect(applyPatch(source("api/seats/hold.ts"), sites[0]?.diff ?? "")).toBe(expected("hold.planted.ts.txt"));
    expect(sites[0]?.confidence.signals).toMatchObject({ read_checks_guard: true, write_result_used: false });
    expect(sites[0]?.confidence.level).toBe("medium");
  });

  it("finds operator and version guards in methods and functions", () => {
    expect(sitesIn("lib/quota.ts").map((site) => [site.line, site.function, site.matched])).toEqual([[12, "consume", "count: { lt: limit }"]]);
    const save = sitesIn("lib/documents.ts").filter((site) => site.function === "saveDocument");
    expect(save.map((site) => site.matched)).toEqual(["version: current.version"]);
    expect(save[0]?.diff).toContain("-    where: { id: current.id, version: current.version },\n+    where: { id: current.id },\n");
  });

  it("does not report a guard in the first position, which the rewrite cannot remove with its comma", () => {
    expect(sitesIn("lib/quota.ts").some((site) => site.function === "consumeLeading")).toBe(false);
  });

  it("marks the planted form unconfirmed, and the level low, when another guard remains", () => {
    const archive = sitesIn("lib/documents.ts").filter((site) => site.function === "archiveDocument");
    expect(archive.map((site) => site.matched)).toEqual(["archived: false", "locked: false"]);
    for (const site of archive) {
      expect(site.planted_form_confirmed).toBe(false);
      expect(site.confidence.level).toBe("low");
    }
  });

  it("marks the planted form unconfirmed when a guard in the first position remains", () => {
    const text = [
      "export async function publish(documentId: string) {",
      "  const row = await db.client.document.findUniqueOrThrow({ where: { id: documentId } });",
      "  await db.client.document.update({ where: { active: false, id: row.id, version: row.version }, data: { active: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/publish.ts", text);
    expect(sites.map((site) => site.matched)).toEqual(["version: row.version"]);
    expect(sites[0]?.planted_form_confirmed).toBe(false);
    expect(sites[0]?.confidence.level).toBe("low");
  });

  it("marks the planted form unconfirmed when the where spreads a filter that can hold another guard", () => {
    const text = [
      "export async function redeem(code: string) {",
      "  const row = await db.client.voucher.findFirst({ where: { code } });",
      "  const expected = { id: row.id, used: false };",
      "  await db.client.voucher.update({ where: { ...expected, version: row.version }, data: { used: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/redeem.ts", text);
    expect(sites.map((site) => site.matched)).toEqual(["version: row.version"]);
    expect(sites[0]?.planted_form_confirmed).toBe(false);
    expect(sites[0]?.confidence.level).toBe("low");
  });

  it("marks the planted form unconfirmed when any non-identity key survives, whatever its value form", () => {
    const text = [
      "export async function publish(documentId: string, ownerId: string) {",
      "  const row = await db.client.document.findUniqueOrThrow({ where: { id: documentId } });",
      "  await db.client.document.update({ where: { id: row.id, status: row.status, version: row.version }, data: { active: true } });",
      "  await db.client.document.update({ where: { id: row.id, AND: [{ status: row.status }], version: row.version }, data: { active: true } });",
      "  await db.client.document.update({ where: { id: row.id, ownerId, version: row.version }, data: { active: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/publish.ts", text);
    expect(sites.map((site) => [site.line, site.matched, site.planted_form_confirmed, site.confidence.level])).toEqual([
      [3, "version: row.version", false, "low"],
      [4, "version: row.version", false, "low"],
      [5, "version: row.version", false, "low"],
    ]);
  });

  it("confirms the planted form when the only other surviving key is one the read filters on", () => {
    const text = [
      "export async function publish(documentId: string, owner: { id: string }) {",
      "  const ownerId = owner.id;",
      "  const row = await db.client.document.findFirst({ where: { id: documentId, ownerId } });",
      "  await db.client.document.update({ where: { id: row.id, ownerId, version: row.version }, data: { active: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/publish.ts", text);
    expect(sites.map((site) => [site.matched, site.planted_form_confirmed])).toEqual([["version: row.version", true]]);
  });

  it("leaves the planted form unconfirmed when a surviving scope key holds a different value than the read's", () => {
    const text = [
      "export async function publish(documentId: string, tenants: string[]) {",
      "  const [readTenant, writeTenant] = tenants;",
      "  const row = await db.client.document.findFirst({ where: { id: documentId, tenantId: readTenant } });",
      "  await db.client.document.update({ where: { id: row.id, tenantId: writeTenant, version: row.version }, data: { active: true } });",
      "  await db.client.document.update({ where: { id: row.id, tenantId: readTenant, version: row.version }, data: { active: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/publish.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [4, false],
      [5, true],
    ]);
  });

  it("confirms a surviving scope key only when its value is a literal or a const name of the enclosing function", () => {
    const text = [
      "export async function reassigned(docId: string, first: string, second: string) {",
      "  let tenantId = first;",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  tenantId = second;",
      "  await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "}",
      "export async function parameter(docId: string, tenantId: string) {",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "}",
      "export async function member(docId: string, scope: { tenantId: string }) {",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId: scope.tenantId } });",
      "  await db.client.document.updateMany({ where: { id: row.id, tenantId: scope.tenantId, active: true }, data: { active: false } });",
      "}",
      "export async function constant(docId: string, scope: { tenantId: string }) {",
      "  const { tenantId } = scope;",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId, orgId: 'acme' } });",
      "  await db.client.document.updateMany({ where: { id: row.id, tenantId, orgId: 'acme', active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [5, false],
      [9, false],
      [13, false],
      [18, true],
    ]);
  });

  it("confirms the read's where id only when it is a literal or a const name", () => {
    const text = [
      "export async function mutable(first: string, second: string) {",
      "  let id = first;",
      "  await db.client.document.findFirst({ where: { id, active: true } });",
      "  id = second;",
      "  await db.client.document.updateMany({ where: { id, active: true }, data: { active: false } });",
      "}",
      "export async function parameter(id: string) {",
      "  await db.client.document.findFirst({ where: { id } });",
      "  await db.client.document.updateMany({ where: { id, active: true }, data: { active: false } });",
      "}",
      "export async function literal() {",
      "  await db.client.document.findFirst({ where: { id: 'doc-1' } });",
      "  await db.client.document.updateMany({ where: { id: 'doc-1', active: true }, data: { active: false } });",
      "}",
      "export async function constant(input: string) {",
      "  const id = input;",
      "  await db.client.document.findFirst({ where: { id } });",
      "  await db.client.document.updateMany({ where: { id, active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [5, false],
      [9, false],
      [13, true],
      [18, true],
    ]);
  });

  it("confirms a const name only when it is declared in the function's top-level block before the read and not redeclared in a block around the write", () => {
    const text = [
      "export async function shadowedParameter(docId: string, tenantId: string, otherTenant: string) {",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  {",
      "    const tenantId = otherTenant;",
      "    await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "  }",
      "}",
      "export async function shadowedConst(docId: string, scope: { tenantId: string }, otherTenant: string) {",
      "  const { tenantId } = scope;",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  if (row) {",
      "    const tenantId = otherTenant;",
      "    await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "  }",
      "}",
      "export async function shadowedId(input: string, other: string) {",
      "  const id = input;",
      "  await db.client.document.findFirst({ where: { id } });",
      "  {",
      "    const id = other;",
      "    await db.client.document.updateMany({ where: { id, active: true }, data: { active: false } });",
      "  }",
      "}",
      "export async function innerBlock(docId: string, scope: { tenantId: string }) {",
      "  if (scope) {",
      "    const { tenantId } = scope;",
      "    const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "    await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "  }",
      "}",
      "export async function topLevel(docId: string, scope: { tenantId: string }) {",
      "  const { tenantId } = scope;",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  if (row) {",
      "    await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "  }",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [5, false],
      [13, false],
      [21, false],
      [28, false],
      [35, true],
    ]);
  });

  it("never confirms a write that sits in a function nested inside the read's, not even through the read's own id", () => {
    const text = [
      "export async function activate(docId: string, tenant: { id: string }, items: string[]) {",
      "  const tenantId = tenant.id;",
      "  const row = await db.client.document.findFirst({ where: { id: docId, tenantId } });",
      "  await Promise.all(items.map(async (tenantId) => db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } })));",
      "  await Promise.all(items.map(async () => db.client.document.updateMany({ where: { id: row.id, active: true }, data: { active: false } })));",
      "  await db.client.document.updateMany({ where: { id: row.id, tenantId, active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [4, false],
      [5, false],
      [6, true],
    ]);
  });

  it("does not confirm a nested write whose id names a callback parameter that shadows the read filter's id", () => {
    const text = [
      "export async function activate(id: string, ids: string[]) {",
      "  await db.client.document.findFirst({ where: { id } });",
      "  await Promise.all(ids.map(async (id) => db.client.document.updateMany({ where: { id, active: true }, data: { active: false } })));",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed, site.confidence.level])).toEqual([[3, false, "low"]]);
  });

  it("confirms a surviving id only when it holds the read's own id", () => {
    const text = [
      "export async function activate(ownerId: string, targetId: string, docId: string) {",
      "  const row = await db.client.document.findFirst({ where: { ownerId } });",
      "  await db.client.document.updateMany({ where: { id: targetId, active: false }, data: { active: true } });",
      "  await db.client.document.updateMany({ where: { id: row.id, active: false }, data: { active: true } });",
      "  await db.client.document.updateMany({ where: { id: row.ownerId, active: false }, data: { active: true } });",
      "  await db.client.document.updateMany({ where: { id, active: false }, data: { active: true } });",
      "}",
      "export async function pinned(input: string) {",
      "  const docId = input;",
      "  const { id: readId, title = docId } = await db.client.document.findFirst({ where: { id: docId } });",
      "  await db.client.document.updateMany({ where: { id: docId, active: false }, data: { active: true } });",
      "  await db.client.document.updateMany({ where: { id: readId, active: false }, data: { active: true } });",
      "  await db.client.document.updateMany({ where: { id: title, active: false }, data: { active: true } });",
      "}",
      "export async function shorthand(docId: string) {",
      "  const { id } = await db.client.document.findFirst({ where: { id: docId } });",
      "  await db.client.document.updateMany({ where: { id, active: false }, data: { active: true } });",
      "}",
      "export async function defaulted(docId: string, fallback: string) {",
      "  const { id = fallback } = await db.client.document.findFirst({ where: { title: docId } });",
      "  await db.client.document.updateMany({ where: { id, active: false }, data: { active: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/activate.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed])).toEqual([
      [3, false],
      [4, true],
      [5, false],
      [6, false],
      [11, true],
      [12, true],
      [13, false],
      [17, true],
      [21, false],
    ]);
  });

  it("takes only names the read's destructuring binds, not a default value or a computed key", () => {
    const text = [
      "export async function claim(seatId: string, fallback: string, field: string) {",
      "  const { id = fallback } = await db.client.seat.findFirst({ where: { id: seatId, taken: false } });",
      "  await db.client.seat.update({ where: { id: fallback, taken: false }, data: { taken: true } });",
      "}",
      "export async function pick(seatId: string, field: string) {",
      "  const { [field]: picked, ...rest } = await db.client.seat.findFirst({ where: { id: seatId, taken: false } });",
      "  await db.client.seat.update({ where: { id: field, taken: false }, data: { taken: true } });",
      "  await db.client.seat.update({ where: { id: picked, taken: false }, data: { taken: true } });",
      "  await db.client.seat.update({ where: { id: rest.id, taken: false }, data: { taken: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/seats.ts", text);
    expect(sites.map((site) => [site.line, site.confidence.signals.identity_from_read])).toEqual([
      [3, false],
      [7, false],
      [8, true],
      [9, true],
    ]);
  });

  it("takes a read's bound names as the write's identity only when the binding is const", () => {
    const text = [
      "export async function reassigned(seatId: string, fallback: { id: string }) {",
      "  let row = await db.client.seat.findUnique({ where: { id: seatId } });",
      "  row = fallback;",
      "  await db.client.seat.update({ where: { id: row.id, taken: false }, data: { taken: true } });",
      "}",
      "export async function hoisted(seatId: string) {",
      "  var { id } = await db.client.seat.findFirst({ where: { title: seatId } });",
      "  await db.client.seat.update({ where: { id, taken: false }, data: { taken: true } });",
      "}",
      "export async function constant(seatId: string) {",
      "  const row = await db.client.seat.findUnique({ where: { id: seatId } });",
      "  await db.client.seat.update({ where: { id: row.id, taken: false }, data: { taken: true } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/seats.ts", text);
    expect(sites.map((site) => [site.line, site.planted_form_confirmed, site.confidence.signals.identity_from_read])).toEqual([
      [4, false, false],
      [8, false, false],
      [12, true, true],
    ]);
  });

  it("leaves out a guard in a where that holds any comment, where removing it could leave a stray comma", () => {
    const text = [
      "export async function redeem(code: string) {",
      "  const row = await db.client.voucher.findFirst({ where: { code } });",
      "  await db.client.voucher.update({ where: { id: row.id, /* CAS */ used: false }, data: { used: true } });",
      "  await db.client.voucher.update({ where: { id: row.id, /* CAS */ used: false, tenantId: row.tenantId }, data: { used: true } });",
      "  await db.client.voucher.update({ where: { id: row.id, used: false /* CAS */ }, data: { used: true } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/redeem.ts", text)).toEqual([]);
  });

  it("gives the full confidence for operator and version guards", () => {
    expect(sitesIn("lib/quota.ts")[0]?.confidence).toEqual({
      score: 0.9,
      level: "high",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: true, identity_from_read: true, await_between: false },
    });
    expect(sitesIn("lib/documents.ts").find((site) => site.function === "saveDocument")?.confidence).toEqual({
      score: 0.8,
      level: "high",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: false, identity_from_read: true, await_between: true },
    });
  });

  it("does not count identity from the read when the write's identity comes from a parameter", () => {
    const site = sitesIn("lib/coupons.ts").find((found) => found.function === "applyCoupon");
    expect(site?.matched).toBe("spent: false");
    // A parameter id never confirms the planted form, so the level is low whatever the score.
    expect(site?.planted_form_confirmed).toBe(false);
    expect(site?.confidence).toEqual({
      score: 0.55,
      level: "low",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: false, identity_from_read: false, await_between: false },
    });
  });

  it("scores against the last read of the model before the write", () => {
    // The first read neither filters on the guard nor gives the write its identity; the second does both.
    const site = sitesIn("lib/coupons.ts").find((found) => found.function === "claimPass");
    expect(site?.matched).toBe("claimed: false");
    expect(site?.confidence).toEqual({
      score: 0.7,
      level: "medium",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: false, identity_from_read: true, await_between: false },
    });
  });

  it("counts identity from the read when a destructured field reaches the write as shorthand", () => {
    const code = [
      "export async function claimSeat(seatId: string) {",
      "  const { id } = await db.client.seat.findFirst({ where: { id: seatId, taken: false } });",
      "  await db.client.seat.update({ where: { id, taken: false }, data: { taken: true } });",
      "}",
      "",
    ].join("\n");
    const [site, ...rest] = findSitesInSource(CLASSES, "lib/seats.ts", code);
    expect(rest).toEqual([]);
    expect(site?.matched).toBe("taken: false");
    expect(site?.confidence).toEqual({
      score: 0.7,
      level: "medium",
      signals: { read_before_write: true, read_checks_guard: true, write_result_used: false, identity_from_read: true, await_between: false },
    });
  });

  it("counts a bound write result used later as shorthand", () => {
    const code = [
      "export async function claimSeat(seatId: string) {",
      "  const { id } = await db.client.seat.findFirst({ where: { id: seatId, taken: false } });",
      "  const result = await db.client.seat.updateMany({ where: { id, taken: false }, data: { taken: true } });",
      "  return { result };",
      "}",
      "",
    ].join("\n");
    const [site, ...rest] = findSitesInSource(CLASSES, "lib/seats.ts", code);
    expect(rest).toEqual([]);
    expect(site?.matched).toBe("taken: false");
    expect(site?.confidence.signals).toMatchObject({ write_result_used: true });
  });

  it("scores a write whose only read of the model comes later as low", () => {
    const [site, ...rest] = sitesIn("lib/late-read.ts");
    expect(rest).toEqual([]);
    expect(site?.confidence).toMatchObject({ score: 0, level: "low", signals: { read_before_write: false } });
  });

  it("matches none of the negative cases", () => {
    expect(sitesIn("lib/negatives.ts")).toEqual([]);
  });

  it("splits an upsert into a read and a create or update, in any key order", () => {
    const sites = sitesIn("api/preferences/route.ts");
    expect(sites.map((site) => [site.rule_id, site.line, site.function])).toEqual([
      ["race.upsert", 6, "POST"],
      ["race.upsert", 19, "touchProfile"],
    ]);
    expect(sites[1]?.confidence).toEqual({
      score: 1,
      level: "high",
      signals: { not_in_batch_transaction: true, create_covers_where: true, where_is_object: true, request_handler: true },
    });
    expect(applyPatch(source("api/preferences/route.ts"), sites[0]?.diff ?? "")).toBe(expected("route.planted.ts.txt"));
    expect(sites.every((site) => site.planted_form_confirmed)).toBe(true);
    expect(sites[0]?.confidence.level).toBe("high");
  });

  it("does not match an upsert with a spread or a shorthand key besides where, update and create", () => {
    const functions = sitesIn("api/preferences/route.ts").map((site) => site.function);
    expect(functions).not.toContain("mergePreference");
    expect(functions).not.toContain("readTheme");
  });

  it("scores the upsert signals each on its own, outside any api directory", () => {
    const sites = sitesIn("lib/settings.ts");
    expect(sites.map((site) => [site.function, site.planted_form_confirmed, site.confidence])).toEqual([
      [
        "POST",
        true,
        {
          score: 1,
          level: "high",
          signals: { not_in_batch_transaction: true, create_covers_where: true, where_is_object: true, request_handler: true },
        },
      ],
      [
        "saveScopedSetting",
        true,
        {
          score: 0.5,
          level: "medium",
          signals: { not_in_batch_transaction: true, create_covers_where: false, where_is_object: true, request_handler: false },
        },
      ],
      [
        "saveSetting",
        true,
        {
          score: 0.3,
          level: "low",
          signals: { not_in_batch_transaction: true, create_covers_where: false, where_is_object: false, request_handler: false },
        },
      ],
    ]);
  });

  it("reads a .tsx file as TSX, finding a write inside a JSX attribute that a TypeScript parse misses", () => {
    const tsx = source("components/redeem-form.tsx");
    const sites = findSitesInSource(CLASSES, "components/redeem-form.tsx", tsx);
    expect(sites.map((site) => [site.rule_id, site.line, site.function, site.matched, site.planted_form_confirmed])).toEqual([
      ["race.guarded-write", 12, "RedeemForm", "used: false", true],
    ]);
    expect(sites[0]?.diff).toContain("+        await db.client.giftCard.update({ where: { id: gift.id }, data: { used: true } });\n");
    expect(findSitesInSource(CLASSES, "components/redeem-form.ts", tsx)).toEqual([]);
  });

  it("does not match an upsert in the array of a batch transaction, which is neither awaited nor returned", () => {
    expect(sitesIn("api/preferences/route.ts").some((site) => site.function === "resetPreferences")).toBe(false);
  });

  it("matches only an upsert that is the direct operand of await in its own statement, whose values cannot change before the split read", () => {
    const code = [
      "export async function save(db, profileId, next) {",
      "  const pending = db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "  profileId = next;",
      "  await pending;",
      "  void db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "  await Promise.all([db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } })]);",
      "  await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } }).catch(() => null);",
      "  await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "  const row = await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "  return db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code).map((site) => site.line)).toEqual([8, 9]);
  });

  it("does not match an upsert returned from or forming the body of an async function, whose caller may keep the promise", () => {
    const code = [
      "export async function save(db, input) {",
      "  return db.client.preference.upsert({ where: { profileId: input.id }, update: { name: input.name }, create: { profileId: input.id } });",
      "}",
      "export const touch = async (db, profileId) => db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "export async function relay(db, profileId) {",
      "  return await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code)).toEqual([]);
  });

  it("does not match any upsert inside a transaction argument, or one returned from a plain function", () => {
    const code = [
      "export async function POST(db, profileId, ids) {",
      "  await db.client.$transaction(async (tx) => tx.preference.upsert({ where: { profileId }, update: {}, create: { profileId } }));",
      "  await db.client.$transaction(async (tx) => { return tx.preference.upsert({ where: { profileId }, update: {}, create: { profileId } }); });",
      "  await db.client.$transaction(ids.map((id) => { return db.client.preference.upsert({ where: { profileId: id }, update: {}, create: { profileId: id } }); }));",
      "  const build = (id) => { return db.client.preference.upsert({ where: { profileId: id }, update: {}, create: { profileId: id } }); };",
      "  return build;",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code)).toEqual([]);
  });

  it("counts only the read's where, not its select, as filtering on the guard", () => {
    const code = [
      "export async function close(db, id) {",
      "  const room = await db.client.room.findFirst({ where: { id }, select: { id: true, active: true } });",
      "  await db.client.room.update({ where: { id: room.id, active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/rooms.ts", code);
    expect(sites.map((site) => site.confidence.signals.read_checks_guard)).toEqual([false]);
  });

  it("counts only direct fields of the read's where, not a nested relation filter", () => {
    const code = [
      "export async function close(db, id) {",
      "  const room = await db.client.room.findFirst({ where: { id, owner: { active: true } } });",
      "  await db.client.room.update({ where: { id: room.id, active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/rooms.ts", code);
    expect(sites.map((site) => site.confidence.signals.read_checks_guard)).toEqual([false]);
  });

  it("does not match an upsert whose argument names found, which the split callback would shadow", () => {
    const code = [
      "export async function claim(db, found, profileId) {",
      "  await db.client.preference.upsert({ where: { profileId }, update: { ownerId: found.id }, create: { profileId } });",
      "  await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId, found } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code)).toEqual([]);
  });

  it("does not match an upsert whose argument awaits or yields, which the non-async split callback cannot hold", () => {
    const code = [
      "export async function save(db, profileId, input) {",
      "  await db.client.preference.upsert({ where: { profileId }, update: { value: await encode(input) }, create: { profileId } });",
      "  await db.client.preference.upsert({ where: { profileId: await resolve(profileId) }, update: {}, create: { profileId } });",
      "}",
      "export function* seed(db, profileId) {",
      "  yield db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId, value: yield profileId } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code)).toEqual([]);
  });

  it("does not match an upsert whose argument or client would run at a different time or more often once split", () => {
    const code = [
      "export async function save(db, profileId, input, next) {",
      "  await db.client.preference.upsert({ where: { profileId }, update: buildUpdate(input), create: { profileId } });",
      "  await db.client.preference.upsert({ where: { profileId }, update: {}, create: { profileId, createdAt: new Date() } });",
      "  await db.client.preference.upsert({ where: { profileId: next++ }, update: {}, create: { profileId } });",
      "  await db.client.preference.upsert({ where: { profileId }, update: { value: (input = 1) }, create: { profileId } });",
      "  await getDb().preference.upsert({ where: { profileId }, update: {}, create: { profileId } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/prefs.ts", code)).toEqual([]);
  });

  it("does not take a read inside a nested callback as the read before an outer write", () => {
    const code = [
      "export async function close(db, id) {",
      "  const later = async () => db.client.room.findFirst({ where: { id } });",
      "  await db.client.room.update({ where: { id, active: true }, data: { active: false } });",
      "}",
      "",
    ].join("\n");
    expect(findSitesInSource(CLASSES, "lib/rooms.ts", code)).toEqual([]);
  });

  it("counts a read before the write only when the read is awaited directly in its own statement or initializer", () => {
    const code = [
      "export async function claim(db, id) {",
      "  const check = db.client.seat.findFirst({ where: { id, open: true } });",
      "  const result = await db.client.seat.updateMany({ where: { id, open: true }, data: { open: false } });",
      "  await check;",
      "  if (result.count === 0) throw new Error('taken');",
      "}",
      "export async function claimLater(db, id) {",
      "  const [seat] = await Promise.all([db.client.seat.findFirst({ where: { id, open: true } })]);",
      "  const result = await db.client.seat.updateMany({ where: { id, open: true }, data: { open: false } });",
      "  if (result.count === 0) throw new Error('taken');",
      "}",
      "export async function claimAwaited(db, seatId) {",
      "  const id = seatId;",
      "  await db.client.seat.findFirst({ where: { id, open: true } });",
      "  const result = await db.client.seat.updateMany({ where: { id, open: true }, data: { open: false } });",
      "  if (result.count === 0) throw new Error('taken');",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/seats.ts", code);
    expect(
      sites.map((site) => [site.line, site.confidence.signals.read_before_write, site.confidence.signals.read_checks_guard, site.planted_form_confirmed, site.confidence.level]),
    ).toEqual([
      [3, false, false, false, "low"],
      [9, false, false, false, "low"],
      [15, true, true, true, "high"],
    ]);
  });

  it("scores a write in a callback against the read of the function around it", () => {
    const code = [
      "export async function closeAll(db, id, items) {",
      "  const room = await db.client.room.findFirst({ where: { id, active: true } });",
      "  await Promise.all(items.map(async () => {",
      "    const audit = async () => db.client.room.findFirst({ where: { id } });",
      "    await db.client.room.update({ where: { id: room.id, active: true }, data: { active: false } });",
      "  }));",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/rooms.ts", code);
    expect(sites.map((site) => [site.line, site.confidence.signals])).toEqual([
      [5, { read_before_write: true, read_checks_guard: true, write_result_used: false, identity_from_read: true, await_between: false }],
    ]);
  });

  it("scores a write against a read only when the read's block encloses the write", () => {
    const code = [
      "export async function close(db, id, fresh) {",
      "  if (fresh) {",
      "    const room = await db.client.room.findFirst({ where: { id, active: true } });",
      "  } else {",
      "    const result = await db.client.room.updateMany({ where: { id, active: true }, data: { active: false } });",
      "    if (result.count === 0) throw new Error('closed');",
      "  }",
      "}",
      "export async function closeInner(db, id, fresh) {",
      "  const room = await db.client.room.findFirst({ where: { id, active: true } });",
      "  if (fresh) {",
      "    const result = await db.client.room.updateMany({ where: { id, active: true }, data: { active: false } });",
      "    if (result.count === 0) throw new Error('closed');",
      "  }",
      "}",
      "",
    ].join("\n");
    const sites = findSitesInSource(CLASSES, "lib/rooms.ts", code);
    expect(sites.map((site) => [site.line, site.confidence.signals.read_before_write, site.confidence.signals.read_checks_guard])).toEqual([
      [5, false, false],
      [12, true, true],
    ]);
  });

  it("gives each site a diff of that site alone", () => {
    for (const site of sitesIn("lib/documents.ts")) {
      const changed = site.diff.split("\n").filter((line) => /^[-+](?![-+])/.test(line));
      expect(changed).toHaveLength(2);
    }
  });
});

describe("find sites in a tree", () => {
  it("lists every site in sorted order with the prefix, skipping dependencies, declarations and other files", () => {
    const root = materialize();
    const report = findSites(root, RULES, "src/");
    expect(report.files_scanned).toBe(10);
    expect(report.classes).toEqual(["RACE.guarded-write", "RACE.check-then-act"]);
    expect(report.site_count).toBe(15);
    expect(report.sites.map((site) => `${site.path}:${String(site.line)}`)).toEqual([
      "src/api/preferences/route.ts:6",
      "src/api/preferences/route.ts:19",
      "src/api/seats/hold.ts:13",
      "src/api/vouchers/redeem.ts:17",
      "src/components/redeem-form.tsx:12",
      "src/lib/coupons.ts:9",
      "src/lib/coupons.ts:17",
      "src/lib/documents.ts:7",
      "src/lib/documents.ts:15",
      "src/lib/documents.ts:15",
      "src/lib/late-read.ts:5",
      "src/lib/quota.ts:12",
      "src/lib/settings.ts:6",
      "src/lib/settings.ts:12",
      "src/lib/settings.ts:18",
    ]);
    expect(report.sites[3]?.diff).toContain("--- a/src/api/vouchers/redeem.ts\n");
    expect(JSON.stringify(findSites(root, RULES, "src/"))).toBe(JSON.stringify(report));
  });

  it("writes the report through the CLI and exits 2 without a root", () => {
    const root = materialize();
    const out = join(scratch, "sites.json");
    const run = spawnSync(process.execPath, [CLI, "find-sites", "--root", root, "--record", out], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("find-sites: 15 sites in 10 files");
    const report = JSON.parse(readFileSync(out, "utf8")) as { site_count: number; sites: SiteRecord[] };
    expect(report.site_count).toBe(15);
    expect(report.sites[0]?.path).toBe("api/preferences/route.ts");
    const missing = spawnSync(process.execPath, [CLI, "find-sites"], { encoding: "utf8" });
    expect(missing.status).toBe(2);
    const absent = spawnSync(process.execPath, [CLI, "find-sites", "--root", join(scratch, "absent")], { encoding: "utf8" });
    expect(absent.status).toBe(2);
  });
});

describe("fix expansion", () => {
  const rule = (fix: string) => {
    const loaded = loadRules(Buffer.from(`id: x\nlanguage: TypeScript\nrule: {kind: pair, regex: ^used}\n${fix}`)).get("x");
    if (loaded === undefined) {
      throw new Error("rule x not loaded");
    }
    return loaded;
  };

  it("widens the edit over the siblings that match expandStart or expandEnd", () => {
    expect(applyFix(rule("fix: {template: '', expandStart: {pattern: ','}}\n"), "f({ id, used: false });")).toBe("f({ id });");
    expect(applyFix(rule("fix: {template: '', expandEnd: {pattern: ','}}\n"), "f({ used: false, id });")).toBe("f({  id });");
    expect(applyFix(rule("fix: ''\n"), "f({ id, used: false });")).toBe("f({ id,  });");
  });

  it("refuses a malformed fix mapping", () => {
    expect(() => rule("fix: {expandStart: {pattern: ','}}\n")).toThrow(RuleFileError);
    expect(() => rule("fix: {template: '', expandMiddle: {pattern: ','}}\n")).toThrow(RuleFileError);
    expect(() => rule("fix: {template: '', expandStart: ','}\n")).toThrow(RuleFileError);
    expect(() => rule("fix: {template: '', expandStart: {nonsense: 1}}\n")).toThrow(RuleFileError);
  });

  it("re-indents a multi-line capture to its new position", () => {
    const loaded = loadRules(Buffer.from("id: y\nlanguage: TypeScript\nrule: {pattern: 'wrap($A)'}\nfix: 'other(1, $A)'\n")).get("y");
    if (loaded === undefined) {
      throw new Error("rule y not loaded");
    }
    const input = "function f() {\n  return wrap(\n      {\n        a: 1,\n      },\n  );\n}\n";
    expect(applyFix(loaded, input)).toBe("function f() {\n  return other(1, {\n    a: 1,\n  });\n}\n");
  });
});

const require = createRequire(import.meta.url);
const AST_GREP = join(dirname(require.resolve("@ast-grep/cli/package.json")), "ast-grep");

describe("ast-grep CLI cross-check for the class rules", () => {
  it("gives the same bytes from `ast-grep scan --update-all` as the napi rewrite on every fixture", () => {
    const root = materialize();
    const files = treeFiles().map((file) => file.replace(/\.txt$/, ""));
    const result = spawnSync(process.execPath, [AST_GREP, "scan", "--update-all", "--rule", CLASS_RULE_FILE, ...files.map((file) => join(root, file))], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    for (const file of files) {
      const napi = CLASSES.reduce((text, rule) => applyFix(rule.fixed, text), source(file));
      expect(readFileSync(join(root, file), "utf8"), file).toBe(napi);
    }
    expect(readFileSync(join(root, "api/preferences/route.ts"), "utf8")).not.toBe(source("api/preferences/route.ts"));
  });
});
