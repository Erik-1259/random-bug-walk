import { describe, expect, it } from "vitest";
import { endpointOf, modelCalls, SYMPTOM_SOURCE, symptomFor } from "../src/symptom.ts";
import type { Site } from "../src/types.ts";

// Synthetic diffs modeled on the class fixtures, never taken from a real host.
const GUARDED_WRITE_DIFF = [
  "--- a/api/vouchers/redeem.ts",
  "+++ b/api/vouchers/redeem.ts",
  "@@ -14,7 +14,7 @@",
  "   const spent = await db.client.voucher.updateMany({",
  "-    where: { id: vouchers[index].id, redeemed: false },",
  "+    where: { id: vouchers[index].id },",
  "     data: { redeemed: true },",
  "   });",
  "",
].join("\n");

const UPSERT_DIFF = [
  "--- a/api/preferences/route.ts",
  "+++ b/api/preferences/route.ts",
  "@@ -6,3 +6,8 @@",
  "-  await db.client.preference.upsert({ where: { profileId }, update: { theme }, create: { profileId } });",
  "+  const existing = await db.client.preference.findUnique({ where: { profileId } });",
  "+  if (existing) {",
  "+    await db.client.preference.update({ where: { profileId }, data: { theme } });",
  "+  } else {",
  "+    await db.client.preference.create({ data: { profileId } });",
  "+  }",
  "",
].join("\n");

function site(file: string, diff: string, classId?: string): Site {
  return { file, line: 15, diff, confidence: 0.8, classId };
}

describe("endpointOf", () => {
  it("reads an endpoint from an api directory and drops a route filename", () => {
    expect(endpointOf("src/app/api/2fa/verify/route.ts")).toBe("/api/2fa/verify");
    expect(endpointOf("api/vouchers/redeem.ts")).toBe("/api/vouchers/redeem");
    expect(endpointOf("api/seats/hold.ts")).toBe("/api/seats/hold");
  });

  it("drops route groups and turns a dynamic segment into :name", () => {
    expect(endpointOf("src/app/(admin)/api/teams/[teamId]/route.ts")).toBe("/api/teams/:teamId");
    expect(endpointOf("app/api/files/[...path]/route.tsx")).toBe("/api/files/:path");
  });

  it("has no endpoint for a file outside an api directory", () => {
    expect(endpointOf("lib/coupons.ts")).toBeNull();
  });
});

describe("modelCalls", () => {
  it("lists the model and method of each Prisma read and write a diff touches", () => {
    expect(modelCalls(GUARDED_WRITE_DIFF)).toContainEqual({ model: "voucher", method: "updateMany" });
    expect(modelCalls(UPSERT_DIFF).map((c) => c.method)).toContain("upsert");
  });

  it("ignores calls that are not Prisma reads or writes", () => {
    expect(modelCalls("return Response.json({ ok: true });\n")).toEqual([]);
  });
});

describe("symptomFor", () => {
  it("describes a guarded-write race in user terms, naming the endpoint and model and action", () => {
    const text = symptomFor(site("api/vouchers/redeem.ts", GUARDED_WRITE_DIFF, "RACE.guarded-write"));
    expect(text).toContain("/api/vouchers/redeem");
    expect(text).toContain("voucher.updateMany");
    expect(text).toContain("at the same moment");
  });

  it("describes a check-then-act race as a duplicate record under concurrency", () => {
    const text = symptomFor(site("api/preferences/route.ts", UPSERT_DIFF, "RACE.check-then-act"));
    expect(text).toContain("/api/preferences");
    expect(text).toContain("preference");
    expect(text).toMatch(/duplicate|single/);
  });

  it("falls back to a generic race symptom for an unknown class", () => {
    const text = symptomFor(site("lib/coupons.ts", GUARDED_WRITE_DIFF));
    expect(text).toContain("the coupons operation");
    expect(text).toContain("concurrent load");
  });

  it("never names the guard key the fix removes or the line it is on", () => {
    const text = symptomFor(site("api/vouchers/redeem.ts", GUARDED_WRITE_DIFF, "RACE.guarded-write"));
    expect(text).not.toContain("redeemed: false");
    expect(text).not.toContain("where");
    expect(text).not.toMatch(/\bline 1[45]\b/);
  });

  it("names the generation that made it", () => {
    expect(SYMPTOM_SOURCE).toBe("race-class-template-v1");
  });
});
