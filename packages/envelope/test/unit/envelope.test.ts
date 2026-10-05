import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { admissionEnvelope, observeEnvelope, judgeEnvelope, modelCallEnvelope, tavilyCallEnvelope, parseRateSheet, loadRateSheet, priceFor, toReserveRequest, runtime_profile_sha256, FIXED_LIMITS } from "../../src/index.ts";
import { fraction } from "../../src/fraction.ts";
import { identity } from "../identity.ts";

const path = new URL("../../rate-sheets/v1.json", import.meta.url);
const raw = await readFile(path, "utf8");
const rates = parseRateSheet(raw);
const vector = JSON.parse(await readFile(new URL("../vector.json", import.meta.url), "utf8")) as { canonical: string; sha256: string };
function success<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) throw new Error("expected successful envelope");
  return value as Extract<T, { ok: true }>;
}
const builders = [observeEnvelope, (r: typeof rates) => admissionEnvelope(r, { includeGeneration: false }), (r: typeof rates) => admissionEnvelope(r, { includeGeneration: true }), judgeEnvelope, modelCallEnvelope, tavilyCallEnvelope];

test("rate sheet canonical bytes and SHA-256 vector", async () => {
  expect(rates.rate_sheet_sha256).toBe(vector.sha256);
  expect(createHash("sha256").update(vector.canonical).digest("hex")).toBe(vector.sha256);
  expect(await loadRateSheet(path)).toEqual(rates);
  const reordered = Object.fromEntries(Object.entries(rates.sheet).reverse());
  expect(parseRateSheet(JSON.stringify(reordered, null, 4))).toEqual(rates);
});
test("fixed limits are frozen and profile hash pins their canonical form", () => {
  expect(Object.isFrozen(FIXED_LIMITS)).toBe(true);
  expect(Object.isFrozen(FIXED_LIMITS.app)).toBe(true);
  expect(runtime_profile_sha256).toMatch(/^[a-f0-9]{64}$/);
});
for (const [name, mutate] of [
  ["unknown field", (s: typeof rates.sheet) => ({ ...s, extra: true })],
  ["duplicate triple", (s: typeof rates.sheet) => ({ ...s, entries: [...s.entries, s.entries[0]] })],
  ["fractional price", (s: typeof rates.sheet) => ({ ...s, entries: [{ ...s.entries[0], price: { microusd: "1.5", per_units: 1 } }] })],
  ["zero denominator", (s: typeof rates.sheet) => ({ ...s, entries: [{ ...s.entries[0], price: { microusd: 1, per_units: 0 } }] })],
  ["unknown unit", (s: typeof rates.sheet) => ({ ...s, entries: [{ ...s.entries[0], unit: "synthetic-unit" }] })],
  ["confirmed account", (s: typeof rates.sheet) => ({ ...s, account_confirmed: true })],
] as const) test(`schema refuses ${name}`, () => { expect(() => parseRateSheet(JSON.stringify(mutate(rates.sheet)))).toThrow(); });
for (const token of ["1.5", "1e3", "9007199254740992"]) test(`canonical restrictions refuse numeric token ${token}`, () => {
  expect(() => parseRateSheet(raw.replace('"microusd": 128000', `"microusd": ${token}`))).toThrow();
});
const limits = [[4560,9120,2],[52440,104880,14],[52440,104880,14,393216,98304,12],[12240,24480,4],[32768,8192],[2]];
for (const [index, build] of builders.entries()) test(`envelope ${String(index)} has exact lines and rounding gap`, () => {
  const result = success(build(rates));
  expect(result.lines.map(l => l.limit)).toEqual(limits[index]);
  const units = index < 4 ? ["vcpu_second", "memory_gb_second", "creation", ...(index === 2 ? ["input_token", "output_token", "credit"] : [])] : index === 4 ? ["input_token", "output_token"] : ["credit"];
  expect(result.lines.map(l => l.unit)).toEqual(units);
  for (const line of result.lines) {
    const subject = line.service === "vercel-sandbox" ? "iad1" : line.service === "tavily" ? "api" : "nvidia/Nemotron-3_5-Lightning";
    expect(line.price).toEqual(priceFor(rates.sheet, line.service, subject, line.unit));
    expect(line.enforced_by).toBe(line.unit.endsWith("second") ? "provider_timeout" : ["output_token", "credit"].includes(line.unit) ? "request_parameter" : "client_counter");
  }
  expect(result.reserved_microusd - result.bound_microusd >= 0n).toBe(true);
  expect(result.reserved_microusd - result.bound_microusd <= BigInt(result.lines.length - 1)).toBe(true);
});
test("observe figure rounds up to 215842", () => {
  const r = success(observeEnvelope(rates));
  expect(r.exact_microusd).toEqual({ numerator: 1079206n, denominator: 5n, decimal_usd: "0.2158412" });
  expect(r.bound_microusd).toBe(215842n); expect(r.reserved_microusd).toBe(215843n);
  expect(Object.values(r.components).map(c => c.decimal_usd)).toEqual(["0.1988", "0.01704", "0.0000012"]);
});
test("admission pre-Tavily figure rounds up to 2529355", () => {
  const r = success(admissionEnvelope(rates, { includeGeneration: true }));
  const { numerator: n, denominator: d } = r.exact_microusd;
  expect(fraction(n - 96000n * d, d)).toEqual({ numerator: 63233858n, denominator: 25n, decimal_usd: "2.52935432" });
  expect(r.exact_microusd).toEqual({ numerator: 65633858n, denominator: 25n, decimal_usd: "2.62535432" });
  expect(r.components.model?.decimal_usd).toBe("0.04718592");
  expect(r.components.tavily?.decimal_usd).toBe("0.096");
  expect(r.exact_microusd.decimal_usd).toBe("2.62535432");
  expect(r.bound_microusd - 96000n).toBe(2529355n); expect(r.reserved_microusd).toBe(2625356n);
});
test("judge figure rounds up to 579363", () => {
  const r = success(judgeEnvelope(rates));
  expect(r.exact_microusd).toEqual({ numerator: 2896812n, denominator: 5n, decimal_usd: "0.5793624" });
  expect(r.bound_microusd).toBe(579363n); expect(r.reserved_microusd).toBe(579363n);
  expect(Object.values(r.components).map(c => c.decimal_usd)).toEqual(["0.5396", "0.03976", "0.0000024"]);
});
test("admission without generation totals", () => {
  const r = success(admissionEnvelope(rates, { includeGeneration: false }));
  expect(r.exact_microusd).toEqual({ numerator: 12410842n, denominator: 5n, decimal_usd: "2.4821684" });
  expect(r.bound_microusd).toBe(2482169n); expect(r.reserved_microusd).toBe(2482170n);
  expect(Object.values(r.components).map(c => c.decimal_usd)).toEqual(["2.3288", "0.15336", "0.0000084"]);
});
for (const entry of rates.sheet.entries) test(`missing ${entry.service}/${entry.unit} refuses`, () => {
  const sheet = { ...rates.sheet, entries: rates.sheet.entries.filter(e => e !== entry) };
  expect(admissionEnvelope(parseRateSheet(JSON.stringify(sheet)), { includeGeneration: true })).toEqual({ ok: false, code: "unknown_price", missing: [{ service: entry.service, subject: entry.subject, unit: entry.unit }] });
});
test("all missing prices are reported with no lines", () => {
  const r = admissionEnvelope(parseRateSheet(JSON.stringify({ ...rates.sheet, entries: [] })), { includeGeneration: true });
  expect(r).toEqual({ ok: false, code: "unknown_price", missing: rates.sheet.entries.map(({ service, subject, unit }) => ({ service, subject, unit })) });
});
test("five-times vCPU price enforces operation ceilings", () => {
  const raised = parseRateSheet(JSON.stringify({ ...rates.sheet, entries: rates.sheet.entries.map(e => e.unit === "vcpu_second" ? { ...e, price: { ...e.price, microusd: 640000 } } : e) }));
  expect(success(observeEnvelope(raised)).reserved_microusd).toBe(864376n);
  expect(admissionEnvelope(raised, { includeGeneration: false })).toEqual({ ok: false, code: "ceiling_exceeded" });
  expect(judgeEnvelope(raised)).toEqual({ ok: false, code: "ceiling_exceeded" });
  const high = parseRateSheet(JSON.stringify({ ...rates.sheet, entries: rates.sheet.entries.map(e => ({ ...e, price: { ...e.price, microusd: 1000000000 } })) }));
  expect(observeEnvelope(high)).toEqual({ ok: false, code: "ceiling_exceeded" });
});
test("reserve identity has no defaults or unknown fields", () => {
  const envelope = observeEnvelope(rates);
  const request = toReserveRequest(envelope, identity());
  expect(request.envelope).toEqual(success(envelope).lines);
  expect(request.rate_sheet_sha256).toBe(rates.rate_sheet_sha256);
  expect(request.runtime_profile_sha256).toBe(runtime_profile_sha256);
  for (const key of Object.keys(identity())) {
    const missing = Object.fromEntries(Object.entries(identity()).filter(([field]) => field !== key));
    expect(() => toReserveRequest(envelope, missing)).toThrow();
  }
  expect(() => toReserveRequest(envelope, { ...identity(), extra: true })).toThrow();
  expect(() => toReserveRequest({ ok: false, code: "ceiling_exceeded" }, identity())).toThrow();
});

test("single calls have exact totals and no operation ceiling", () => {
  const m = success(modelCallEnvelope(rates));
  expect(m.exact_microusd).toEqual({ numerator: 98304n, denominator: 25n, decimal_usd: "0.00393216" });
  expect(m.bound_microusd).toBe(3933n); expect(m.reserved_microusd).toBe(3934n); expect(m.ceiling_microusd).toBeNull();
  const t = success(tavilyCallEnvelope(rates));
  expect(t.exact_microusd).toEqual({ numerator: 16000n, denominator: 1n, decimal_usd: "0.016" });
  expect(t.bound_microusd).toBe(16000n); expect(t.reserved_microusd).toBe(16000n); expect(t.ceiling_microusd).toBeNull();
});
test("non-terminating exact USD omits decimal string", () => {
  const synthetic = parseRateSheet(JSON.stringify({ ...rates.sheet, entries: rates.sheet.entries.map(e => ({ ...e, price: { microusd: 1, per_units: 7 } })) }));
  expect(success(tavilyCallEnvelope(synthetic)).exact_microusd).toEqual({ numerator: 2n, denominator: 7n });
});
test("identity rejects invalid spend formats and inconsistent attempt predecessor", () => {
  for (const fields of [{ pool_key: "x".repeat(65) }, { provider_replay_key: "synthetic\nkey" }, { provider_replay_key: "x".repeat(513) }, { attempt_ordinal: 2 }, { previous_operation_id: "a".repeat(64) }, { project_id: "SYNTHETIC" }]) {
    expect(() => toReserveRequest(observeEnvelope(rates), { ...identity(), ...fields })).toThrow();
  }
});
