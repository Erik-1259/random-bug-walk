#!/usr/bin/env node
// Assembles a results directory for this app (RBW_RESULTS_DIR; see "Results directory" in
// ../README.md) from the public results repository and the public store, in the layout that
// src/release.ts reads:
//   <out>/repository/                 a shallow clone of the results repository
//   <out>/store/status/<root>.json    each published run's public status object
//   <out>/store/sha256/<hash>         each large file's store object (manifest entries with a public_uri)
// Every downloaded store object is checked against its manifest SHA-256. It reads public data
// only and needs no credentials. The build checks the whole directory again (readResults).
// A run the publisher wrote only as a status object (still running, or failed before its
// manifest was published) has no repository directory, and the public store cannot be listed
// without credentials, so such runs are included only when their root IDs are given.
// Usage, from packages/web:
//   node scripts/assemble-results.mjs <new out dir> <repository https url> <public store base uri> [<status-only root id> ...]
/* global Buffer, URL, console, fetch, process, setTimeout */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, repoUrl, base, ...statusOnly] = process.argv.slice(2);
if (!out || !repoUrl || !base) {
  console.error("usage: assemble-results.mjs <new out dir> <repository url> <public store base uri> [<status-only root id> ...]");
  process.exit(2);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
for (const root of statusOnly) {
  if (!UUID.test(root)) {
    console.error(`not a root ID: ${root}`);
    process.exit(2);
  }
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
/**
 * A published run's status object must say published. The publisher pushes the repository
 * before it rewrites the status, and the store caches status objects for up to 60 seconds, so
 * right after a publication the fetch can return the earlier status: wait and fetch it again.
 */
async function publishedStatus(root, attempts = 7, waitMs = 15_000) {
  for (let attempt = 1; ; attempt++) {
    const bytes = await fetchBytes(new URL(`status/${root}.json`, base).href);
    if (JSON.parse(bytes.toString("utf8")).publication_status === "published") return bytes;
    if (attempt >= attempts) throw new Error(`status/${root}.json does not say published after ${String(attempts)} fetches; retry in a few minutes`);
    console.log(`run ${root}: status not yet published, fetching again in ${String(waitMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

for (const root of existsSync(runs) ? readdirSync(runs) : []) {
  const status = await publishedStatus(root);
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
for (const root of statusOnly) {
  if (existsSync(join(runs, root))) continue;
  const status = await fetchBytes(new URL(`status/${root}.json`, base).href);
  // Published after the clone: its manifest is not in this snapshot, so the build would refuse it.
  if (JSON.parse(status.toString("utf8")).publication_status === "published") {
    throw new Error(`run ${root} was published during assembly; run the script again`);
  }
  writeFileSync(join(out, "store", "status", `${root}.json`), status);
  console.log(`run ${root}: status only`);
}
console.log(`store objects: ${objects}`);
