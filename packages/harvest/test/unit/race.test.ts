import { describe, expect, it } from "vitest";
import { examineRaceFile, READ_METHOD, RACE_CANDIDATE_RULES, WRITE_TEXT } from "../../src/race.ts";

function examine(path: string, before: string, after: string, added?: number[]): ReturnType<typeof examineRaceFile> {
  const lines = added ?? after.split("\n").flatMap((line, index) => (before.split("\n").includes(line) ? [] : [index + 1]));
  return examineRaceFile(path, before, after, new Set(lines));
}

// A synthetic coupon redemption: the coupon is read as unredeemed, the code awaits, then it is
// marked redeemed. The fix adds `redeemed: false` to the write's filter and checks the count.
const REDEEM_BEFORE = `export async function redeem(db: Db, code: string) {
  const coupon = await db.coupon.findFirst({ where: { code } });
  if (!coupon || coupon.redeemed) {
    throw new Error("already redeemed");
  }
  await db.coupon.update({
    where: { id: coupon.id },
    data: { redeemed: true },
  });
}
`;
const REDEEM_AFTER = `export async function redeem(db: Db, code: string) {
  const coupon = await db.coupon.findFirst({ where: { code } });
  if (!coupon || coupon.redeemed) {
    throw new Error("already redeemed");
  }
  const result = await db.coupon.updateMany({
    where: { id: coupon.id, redeemed: false },
    data: { redeemed: true },
  });
  if (result.count === 0) {
    throw new Error("already redeemed");
  }
}
`;

describe("race candidate rule and structural confirmation", () => {
  it("confirms a write whose filter gains a state guard after an awaited read, with the method changed", () => {
    const [match] = examine("src/redeem.ts", REDEEM_BEFORE, REDEEM_AFTER);
    expect(match).toMatchObject({
      line: 6,
      callee: "db.coupon.updateMany",
      function: "redeem",
      outcome: { status: "confirmed", before_line: 6, guard: "redeemed: false" },
    });
    expect(match?.outcome.status === "confirmed" && match.outcome.before_call).toContain("db.coupon.update({");
  });

  it("confirms a MongoDB filter given as the first argument, with an operator object as the guard", () => {
    const before = `export const take = async (orders, id) => {\n  const order = await orders.findOne({ _id: id });\n  if (order.stock < 1) return null;\n  return orders.updateOne({ _id: id }, { $inc: { stock: -1 } });\n};\n`;
    const after = before.replace("orders.updateOne({ _id: id }", "orders.updateOne({ _id: id, stock: { $gt: 0 } }");
    expect(examine("src/take.js", before, after)[0]).toMatchObject({ function: "take", outcome: { status: "confirmed", guard: "stock: { $gt: 0 }" } });
  });

  it("confirms an optimistic version check read from the same field of the record", () => {
    const before = `async function save(repo, id, patch) {\n  const row = await repo.findOneBy({ id });\n  return repo.update({ id }, { ...patch, version: row.version + 1 });\n}\n`;
    const after = before.replace("repo.update({ id }", "repo.update({ id, version: row.version }");
    expect(examine("src/save.ts", before, after)[0]?.outcome).toMatchObject({ status: "confirmed", guard: "version: row.version" });
  });

  it("confirms a Sequelize-style write whose where is in the second argument", () => {
    const before = `export async function claim(Task, id, worker) {\n  const task = await Task.findByPk(id);\n  if (task.status !== "open") return false;\n  await Task.update({ status: "taken", worker }, { where: { id } });\n  return true;\n}\n`;
    const after = before.replace("{ where: { id } }", '{ where: { id, status: "open" } }');
    expect(examine("src/claim.js", before, after)[0]?.outcome).toMatchObject({ status: "confirmed", guard: 'status: "open"' });
  });

  it("rejects a write in a function the parent does not have (function_missing_before)", () => {
    expect(examine("src/redeem.ts", "export const x = 1;\n", REDEEM_AFTER)[0]?.outcome).toMatchObject({ status: "rejected", reason: "function_missing_before" });
  });

  it("rejects a new write rather than a changed one (call_added)", () => {
    const before = `export async function redeem(db: Db, code: string) {\n  const coupon = await db.coupon.findFirst({ where: { code } });\n  return coupon;\n}\n`;
    const after = before.replace("  return coupon;", "  await db.coupon.updateMany({ where: { id: coupon.id, redeemed: false }, data: { redeemed: true } });\n  return coupon;");
    expect(examine("src/redeem.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "call_added" });
  });

  it("rejects a filter that changes a value but adds no condition (guard_not_added)", () => {
    const before = REDEEM_BEFORE;
    const after = before.replace("where: { id: coupon.id }", "where: { id: coupon.couponId }");
    expect(examine("src/redeem.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "guard_not_added" });
  });

  it("rejects an added owner scope rather than a state check (guard_not_state)", () => {
    for (const guard of ["userId: session.user.id", "teamId", "ownerId: owner"]) {
      const after = REDEEM_BEFORE.replace("where: { id: coupon.id }", `where: { id: coupon.id, ${guard} }`);
      expect(examine("src/redeem.ts", REDEEM_BEFORE, after)[0]?.outcome, guard).toMatchObject({ status: "rejected", reason: "guard_not_state" });
    }
  });

  it("rejects a guarded write with no awaited read before it in its function (no_read_before_write)", () => {
    const before = `export async function close(db, id) {\n  await db.ticket.update({ where: { id }, data: { open: false } });\n}\n`;
    const after = before.replace("where: { id }", "where: { id, open: true }");
    expect(examine("src/close.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "no_read_before_write" });
  });

  it("does not count a read inside a nested callback or after the write", () => {
    const before = `export async function close(db, id, ids) {\n  const items = ids.map(async (x) => await db.ticket.findFirst({ where: { id: x } }));\n  await db.ticket.update({ where: { id }, data: { open: false } });\n  await db.ticket.findMany();\n  return items;\n}\n`;
    const after = before.replace("where: { id }, data", "where: { id, open: true }, data");
    expect(examine("src/close.ts", before, after)[0]?.outcome).toMatchObject({ status: "rejected", reason: "no_read_before_write" });
  });

  it("ignores write calls whose filter the commit did not touch", () => {
    const after = REDEEM_BEFORE.replace('throw new Error("already redeemed")', 'throw new Error("redeemed")');
    expect(examine("src/redeem.ts", REDEEM_BEFORE, after)).toEqual([]);
  });

  it("does not match a call that is not a write method, or a write with no object argument", () => {
    for (const call of ["db.coupon.findFirst({ where: { id, redeemed: false } })", "hash.update(text)", "save({ id, redeemed: false })"]) {
      const before = `async function f(db, id, text) {\n  await db.x.findFirst();\n  return 1;\n}\n`;
      const after = before.replace("return 1;", `return ${call};`);
      expect(examine("src/a.ts", before, after), call).toEqual([]);
    }
  });

  it("loads one rule per parser language", () => {
    expect(RACE_CANDIDATE_RULES.rule("src/a.ts").id).toBe("race-guard.candidate.ts");
    expect(RACE_CANDIDATE_RULES.rule("src/a.jsx").id).toBe("race-guard.candidate.tsx");
  });

  it("filters added text by write methods and filters, and reads by read-method names", () => {
    expect(WRITE_TEXT.test("+    where: { id, used: false },")).toBe(true);
    expect(WRITE_TEXT.test("+  await db.code.updateMany({")).toBe(true);
    expect(WRITE_TEXT.test("+  const label = format(day);")).toBe(false);
    expect(WRITE_TEXT.test("+  updatedAt: now,")).toBe(false);
    for (const name of ["find", "findFirst", "findUnique", "getUser", "query", "count", "findByPk"]) {
      expect(READ_METHOD.test(name), name).toBe(true);
    }
    for (const name of ["finder", "getter", "update", "readonly"]) {
      expect(READ_METHOD.test(name), name).toBe(false);
    }
  });
});
