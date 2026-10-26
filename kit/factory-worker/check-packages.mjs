#!/usr/bin/env node
// Checks a prepared packages directory as the factory worker image holds it (the Dockerfile runs it
// on /opt/rbw/factory-packages): index.json (format rbw-prepared-packages/1, at least one entry) and
// the archives it names, flat, each a regular file named <sha256>.<extension> by the sha256 of its
// bytes. Every entry's bug case and validator core must be here. Node built-ins only, so it runs
// before anything else in the image is trusted.
//   node kit/factory-worker/check-packages.mjs <prepared directory>
// Exit codes: 0 the directory is usable; 1 it is not (the reason on stderr); 2 a usage error.
/* global console, process */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = "index.json";
const FORMAT = "rbw-prepared-packages/1";
const HASH = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(`prepared packages: ${message}`);
  process.exit(1);
}

const [dir, ...rest] = process.argv.slice(2);
if (dir === undefined || rest.length > 0) {
  console.error("usage: node kit/factory-worker/check-packages.mjs <prepared directory>");
  process.exit(2);
}

const names = readdirSync(dir).sort();
if (!names.includes(INDEX)) fail(`no ${INDEX}`);
const objects = new Set();
for (const name of names) {
  if (!lstatSync(join(dir, name)).isFile()) fail(`not a regular file: ${name}`);
  if (name === INDEX) continue;
  const sum = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  if (sum !== name.split(".")[0]) fail(`content hash mismatch: ${name}`);
  objects.add(name);
}

let index;
try {
  index = JSON.parse(readFileSync(join(dir, INDEX), "utf8"));
} catch {
  fail(`${INDEX} is not JSON`);
}
if (index === null || typeof index !== "object" || index.format !== FORMAT || !Array.isArray(index.entries)) fail(`${INDEX} is not ${FORMAT}`);
if (index.entries.length === 0) fail(`${INDEX} lists no entries`);
for (const entry of index.entries) {
  for (const part of ["bug_case_sha256", "validator_core_sha256"]) {
    const sha256 = entry?.[part];
    if (typeof sha256 !== "string" || !HASH.test(sha256)) fail(`an entry's ${part} is not a sha256`);
    if (!objects.has(`${sha256}.tar.gz`)) fail(`${String(entry.host_id)} ${String(entry.entry_id)}: no archive ${sha256}.tar.gz for its ${part}`);
  }
}
console.log(`prepared packages: ${String(index.entries.length)} entries, ${String(objects.size)} archives`);
