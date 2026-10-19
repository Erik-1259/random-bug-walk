// The F3 check rounds of one fresh instance: the main block, then one block per control kind,
// each run to its protocol rule, then the late re-read. One JSON line per trial goes to
// trials.jsonl as it finishes; the late re-read (diagnostic only, never graded) goes to
// late-reread.json.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockStatus } from "./block.ts";
import type { BlockRule, BlockStatus } from "./block.ts";
import { KINDS } from "./data.ts";
import type { F3Data, KindId, Outcome } from "./data.ts";
import { httpClient, sleep } from "./http.ts";
import { openMonitor } from "./monitor.ts";
import { runTrial } from "./trial.ts";
import type { TrialRecord } from "./trial.ts";

export interface CheckOptions {
  data: F3Data;
  rules: Record<KindId, BlockRule>;
  baseUrl: string;
  gateUrl: string;
  monitorUrl: string;
  appLogPath: string;
  outDir: string;
  log(message: string): void;
}

export interface CheckResult {
  blocks: Record<KindId, BlockStatus>;
  trials: number;
}

export async function runInstanceChecks(options: CheckOptions): Promise<CheckResult> {
  const { data } = options;
  let origin = performance.now();
  const http = httpClient(options.baseUrl, data.timing.client_timeout_ms, () => Math.round((performance.now() - origin) * 10) / 10);
  const monitor = await openMonitor(options.monitorUrl, data.environment.app_role);
  const trialsFile = join(options.outDir, "trials.jsonl");
  writeFileSync(trialsFile, "");
  const blocks = {} as Record<KindId, BlockStatus>;
  const reads: { kind: KindId; index: number; date: string; x_id: string | null; acknowledged: number }[] = [];
  let trials = 0;
  try {
    for (const kind of KINDS) {
      const rule = options.rules[kind];
      const outcomes: Outcome[] = [];
      let status = blockStatus(rule, outcomes);
      while (status.next_index !== null) {
        const record: TrialRecord = await runTrial(data, kind, status.next_index, {
          http,
          monitor,
          gateUrl: options.gateUrl,
          appLogPath: options.appLogPath,
          resetOrigin: () => {
            origin = performance.now();
          },
        });
        trials += 1;
        appendFileSync(trialsFile, `${JSON.stringify(record)}\n`);
        outcomes.push(record.classification.outcome);
        const x = record.observation.completions.find((view) => view.label === "x");
        reads.push({ kind, index: record.observation.index, date: record.observation.date, x_id: x?.body?.id ?? null, acknowledged: record.classification.acknowledged });
        const { outcome, invalid } = record.classification;
        options.log(`${kind} ${String(record.observation.index)}: ${outcome}${invalid.length > 0 ? ` (${invalid.join(", ")})` : ""}`);
        status = blockStatus(rule, outcomes);
      }
      blocks[kind] = status;
      options.log(`${kind} block ${status.state}: ${String(status.valid)} valid, ${String(status.invalid)} invalid`);
    }
    await sleep(data.timing.late_reread_wait_ms);
    const late = [];
    for (const read of reads) {
      const handle = http.send("GET", `/api/reports/completions/daily?date=${read.date}&time_zone=${encodeURIComponent(data.environment.report_time_zone)}`, undefined);
      await handle.done;
      const json = handle.json as { count?: unknown } | null;
      late.push({ ...read, report_status: handle.view.status, report_count: typeof json?.count === "number" ? json.count : null, ...(await monitor.directRead(read.date, read.x_id)) });
    }
    writeFileSync(join(options.outDir, "late-reread.json"), `${JSON.stringify({ waited_ms: data.timing.late_reread_wait_ms, graded: false, reads: late }, null, 2)}\n`);
  } finally {
    await monitor.close();
  }
  return { blocks, trials };
}
