// The shared-service reservation (spec §9.4): one @rbw/spend reservation on judge-demo/judge for
// what judging uses besides each replay's own sandboxes: the results site and the judge routes'
// functions, the private Blob store, and the VCR storage of the controller image and the release's
// kit image (every replay's copies start from the kit image) through judging. The conductor runs
// it once, before judge access goes live:
//
//   node tools/controller/scripts/reserve-shared-services.ts --release <release.json>
//
// It reads DATABASE_URL from the environment and prints no part of it. The reservation is named by
// its call name, so a second run returns the first reservation (replay=true) and writes nothing.
// The rate sheet has none of these prices, so each line carries its price and its source here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runtime_profile_sha256 } from "@rbw/envelope";
import { callName, canonicalDigest, operationId, parseRecord, providerCallIdentity } from "@rbw/schema";
import type { Release } from "@rbw/schema";
import type { EnvelopeLine, ReserveRequest, Spend } from "@rbw/spend";
import { databaseLedger } from "../src/ledger.ts";
import { JUDGE } from "../src/limits.ts";

const GB = 1_000_000_000;
/** Judging and its storage are bounded by two months. */
const MONTHS = 2;

interface PricedLine extends EnvelopeLine {
  source_url: string;
}

/** The priced lines: on-demand prices for iad1 (Washington, D.C.), checked 2026-10-11, and the most judging is reserved for. */
export const SHARED_SERVICE_LINES: readonly PricedLine[] = [
  { service: "vercel-functions-invocations", unit: "call", limit: 100_000, enforced_by: "fixed_allowance", price: { microusd: 600_000, per_units: 1_000_000 }, source_url: "https://vercel.com/docs/functions/usage-and-pricing" },
  { service: "vercel-functions-active-cpu", unit: "vcpu_second", limit: 36_000, enforced_by: "fixed_allowance", price: { microusd: 128_000, per_units: 3_600 }, source_url: "https://vercel.com/docs/pricing/regional-pricing/iad1" },
  { service: "vercel-functions-memory", unit: "memory_gb_second", limit: 360_000, enforced_by: "fixed_allowance", price: { microusd: 10_600, per_units: 3_600 }, source_url: "https://vercel.com/docs/pricing/regional-pricing/iad1" },
  { service: "vercel-cdn-requests", unit: "call", limit: 1_000_000, enforced_by: "fixed_allowance", price: { microusd: 2_000_000, per_units: 1_000_000 }, source_url: "https://vercel.com/docs/pricing/regional-pricing/iad1" },
  { service: "vercel-fast-data-transfer", unit: "byte", limit: 20 * GB, enforced_by: "fixed_allowance", price: { microusd: 150_000, per_units: GB }, source_url: "https://vercel.com/docs/pricing/regional-pricing/iad1" },
  { service: "vercel-fast-origin-transfer", unit: "byte", limit: 5 * GB, enforced_by: "fixed_allowance", price: { microusd: 60_000, per_units: GB }, source_url: "https://vercel.com/docs/pricing/regional-pricing/iad1" },
  // Storage lines count byte-months: bytes stored times the months they are kept.
  { service: "vercel-blob-storage", unit: "byte", limit: 2 * GB * MONTHS, enforced_by: "fixed_allowance", price: { microusd: 23_000, per_units: GB }, source_url: "https://vercel.com/docs/vercel-blob/usage-and-pricing" },
  { service: "vercel-blob-simple-operations", unit: "operation", limit: 100_000, enforced_by: "fixed_allowance", price: { microusd: 400_000, per_units: 1_000_000 }, source_url: "https://vercel.com/docs/vercel-blob/usage-and-pricing" },
  { service: "vercel-blob-advanced-operations", unit: "operation", limit: 50_000, enforced_by: "fixed_allowance", price: { microusd: 5_000_000, per_units: 1_000_000 }, source_url: "https://vercel.com/docs/vercel-blob/usage-and-pricing" },
  { service: "vercel-blob-data-transfer", unit: "byte", limit: 20 * GB, enforced_by: "fixed_allowance", price: { microusd: 50_000, per_units: GB }, source_url: "https://vercel.com/docs/vercel-blob/usage-and-pricing" },
  { service: "vcr-storage-controller-image", unit: "byte", limit: 2 * GB * MONTHS, enforced_by: "fixed_allowance", price: { microusd: 100_000, per_units: GB }, source_url: "https://vercel.com/docs/container-registry/limits-and-pricing" },
  { service: "vcr-storage-kit-image", unit: "byte", limit: 6 * GB * MONTHS, enforced_by: "fixed_allowance", price: { microusd: 100_000, per_units: GB }, source_url: "https://vercel.com/docs/container-registry/limits-and-pricing" },
];

const KIND = "shared.services";

function uuidOf(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The one reservation, named by the release: the same release always gives the same operation. */
export function sharedServicesRequest(release: Release): ReserveRequest {
  const [revision] = release.revisions;
  if (revision === undefined) throw new Error("the release names no task revision");
  const root = uuidOf(`shared-services:${release.release_id}`);
  const batch = uuidOf(`shared-services-batch:${release.release_id}`);
  const call = callName(KIND, "judge", release.release_id);
  const envelope: EnvelopeLine[] = SHARED_SERVICE_LINES.map(({ service, unit, limit, enforced_by, price }) => ({ service, unit, limit, enforced_by, price }));
  const identity = providerCallIdentity({
    project_id: release.project_id,
    project_policy_sha256: release.project_policy_sha256,
    root_execution_id: root,
    batch_id: batch,
    task_revision: revision.sha256,
    kind: KIND,
    runtime_profile_sha256,
    attempt_ordinal: 1,
    call_name: call,
  });
  return {
    operation_id: operationId(identity).sha256,
    payload_hash: canonicalDigest({ release_id: release.release_id, envelope }).sha256,
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: release.project_id,
    project_policy_sha256: release.project_policy_sha256,
    batch_id: batch,
    task_revision: revision.sha256,
    root_execution_id: root,
    execution_id: root,
    parent_execution_id: null,
    kind: KIND,
    call_name: call,
    provider: "vercel",
    provider_replay_key: null,
    pool_key: JUDGE.pool_key,
    allocation_key: JUDGE.allocation_key,
    runtime_profile_sha256,
    // The prices are this script's own, so their hash takes the rate sheet's place.
    rate_sheet_sha256: canonicalDigest(SHARED_SERVICE_LINES).sha256,
    envelope,
  };
}

export async function reserveSharedServices(spend: Spend, release: Release): Promise<string> {
  const reserved = await spend.reserve(sharedServicesRequest(release));
  if (!reserved.ok) return `shared_services refused ${reserved.code}`;
  return `shared_services operation=${reserved.operation_id} reserved=${reserved.reserved_microusd.toString()} replay=${String(reserved.replay)} judge_available=${String(reserved.allocation_available_microusd)}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { release: { type: "string" } }, strict: true, allowPositionals: false });
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (values.release === undefined || databaseUrl === "") {
    process.stderr.write("usage: DATABASE_URL set; node tools/controller/scripts/reserve-shared-services.ts --release <release.json>\n");
    return 2;
  }
  const release = parseRecord("Release", readFileSync(resolve(values.release)));
  const ledger = await databaseLedger(databaseUrl, () => new Date());
  try {
    const line = await reserveSharedServices(ledger.spend, release);
    process.stdout.write(`${line}\n`);
    return line.includes("refused") ? 1 : 0;
  } finally {
    await ledger.close();
  }
}

if (import.meta.main) process.exitCode = await main();
