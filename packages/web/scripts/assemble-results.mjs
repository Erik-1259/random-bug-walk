#!/usr/bin/env node
// Assembles a results directory for this app (RBW_RESULTS_DIR; see "Results directory" in
// ../README.md) from the public results repository and the public store, in the layout that
// src/release.ts reads:
//   <out>/repository/                 a shallow clone of the results repository
//   <out>/store/status/<root>.json    each published run's public status object
//   <out>/store/sha256/<hash>         each large file's store object (manifest entries with a public_uri)
// Every downloaded store object is checked against its manifest SHA-256. It reads public data
// only and needs no credentials. The build checks the whole directory again (readResults).
// Usage, from packages/web: node scripts/assemble-results.mjs <new out dir> <repository https url> <public store base uri>
/* global Buffer, URL, console, fetch, process */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, repoUrl, base] = process.argv.slice(2);
if (!out || !repoUrl || !base) {
  console.error("usage: assemble-results.mjs <new out dir> <repository url> <public store base uri>");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists`);
  process.exit(2);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fetchBytes(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt >= 3 || response.status < 500) throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
}

execFileSync("git", ["clone", "-q", "--depth", "1", repoUrl, join(out, "repository")], { stdio: "inherit" });
mkdirSync(join(out, "store", "status"), { recursive: true });
mkdirSync(join(out, "store", "sha256"), { recursive: true });
const runs = join(out, "repository", "runs");
let objects = 0;
for (const root of existsSync(runs) ? readdirSync(runs) : []) {
  const status = await fetchBytes(new URL(`status/${root}.json`, base).href);
  writeFileSync(join(out, "store", "status", `${root}.json`), status);
  const manifest = JSON.parse(readFileSync(join(runs, root, "manifest.json"), "utf8"));
  for (const entry of manifest.entries) {
    if (entry.public_uri === null || entry.public_uri === undefined) continue;
    const target = join(out, "store", "sha256", entry.sha256);
    if (existsSync(target)) continue;
    const bytes = await fetchBytes(entry.public_uri);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.public_uri}: hash differs from runs/${root} ${entry.path}`);
    writeFileSync(target, bytes);
    objects++;
  }
  console.log(`run ${root}: status ok`);
}
console.log(`store objects: ${objects}`);
