// A published run's downloadable files, summarized for the case page; the full list is on the
// run's file index page (/runs/<root>).
import type { RunManifestEntry } from "@rbw/schema";
import { fileHref } from "./model.ts";
import type { Run } from "./release.ts";

export const REPORT_PATH = "report.md";

/** An entry with bytes to download: published, or published truncated. */
export function downloadable(entry: RunManifestEntry): boolean {
  return entry.outcome === "published" || entry.outcome === "truncated";
}

export interface RunFileSummary {
  /** Downloadable manifest entries; manifest.json itself is not counted. */
  count: number;
  /** The sum of their sizes in bytes. */
  bytes: number;
  /** The link to the run's report.md, or null when it published none. */
  reportHref: string | null;
}

export function runFileSummary(run: Run): RunFileSummary | null {
  if (run.manifest === null) return null;
  const files = run.manifest.entries.filter(downloadable);
  const report = files.find((entry) => entry.path === REPORT_PATH);
  return {
    count: files.length,
    bytes: files.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0),
    reportHref: report === undefined ? null : fileHref(run.rootExecutionId, report.path, report.public_uri),
  };
}

/** A byte count in decimal units, one decimal place from a kilobyte up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`;
  const units = ["kB", "MB", "GB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "GB"}`;
}

/** The run's file index page. */
export function runIndexHref(root: string): string {
  return `/runs/${root}`;
}
