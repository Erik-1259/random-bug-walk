// Builds the synthetic results directory for the results site: one completed factory root and its
// release, made with the real code in local mode. The root's admission job runs through the local
// runner's simulated kit behind a fake Docker; stage, the real publisher, build (with a local
// private store) and the publisher's release command then write what they write for a real case.
//   node scripts/release-fixture.ts --out <dir>
// <out>/repository and <out>/store are the results branch's files and the public store's objects,
// laid out as packages/web/scripts/publish-fixture.ts lays them out; <out>/private-store is the
// judge job; <out>/inputs holds the policy, root run, publication record and release ID that
// checkRelease reads. Every ID, image and source is a placeholder.
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RATE_SHEET_PATH } from "@rbw/controller";
import { loadRateSheet } from "@rbw/envelope";
import { candidateIdentity } from "@rbw/local-runner";
import { runCli } from "@rbw/publisher";
import { canonicalDigest } from "@rbw/schema";
import { buildRelease } from "../src/build.ts";
import { stage } from "../src/stage.ts";
import { checkout, destination, publish } from "../test/support/publish.ts";
import { CONTROLLER_IMAGE, RELEASE_ID, canonical, cleanupTempDirs, factoryRun, generatedFiles, tempDir, world, write } from "../test/support/world.ts";

const SOURCES = new URL("../fixtures/sources/", import.meta.url).pathname;

function fail(message: string): never {
  throw new Error(`release fixture: ${message}`);
}

async function releaseFixture(out: string): Promise<void> {
  const w = world();
  const factory = await factoryRun(w, "8100");
  const dir = tempDir();

  const staging = join(dir, "staging");
  const redactions = join(dir, "private", "redactions.txt");
  if (!stage({ run: factory.run, rootRun: factory.rootRunFile, out: staging, redactionsOut: redactions, ...generatedFiles(dir) }).ok) fail("the stage was refused");
  // The simulated kit runs in a temporary host directory that its disk readings name; a real kit's are container paths.
  appendFileSync(redactions, `private_material\t${w.kit.root}\n`);
  const d = destination(w);
  const published = await publish(w, d, { rootRun: factory.rootRunFile, staging, redactions });
  if (published.record?.status !== "published") fail(`publish exited ${String(published.result.code)}`);
  const publication = write(join(dir, "inputs", "publication.json"), canonical(published.record));

  const issueSha256 = canonicalDigest(JSON.parse(readFileSync(join(SOURCES, "issue.json"), "utf8")) as never).sha256;
  const mutationId = candidateIdentity(factory.ctx).mutation_id ?? fail("the admission names no mutation");
  const releaseDir = join(dir, "release");
  const privateStore = join(dir, "private-store");
  const built = await buildRelease(
    {
      releaseId: RELEASE_ID,
      run: checkout(d.remote, `runs/${factory.ids.root_execution_id}`),
      publication,
      policy: w.policy.file,
      rootRun: factory.rootRunFile,
      issue: join(SOURCES, "issue.json"),
      issueCheck: join(SOURCES, "issue-check.json"),
      recordings: join(SOURCES, "recordings"),
      approval: write(join(dir, "inputs", "approval.json"), canonical({ decision: "approved", issue_sha256: issueSha256, reviewed_at: "2026-10-14T10:00:00Z" })),
      registry: write(
        join(dir, "inputs", "families.json"),
        canonical({ schema_version: 1, families: [{ family_id: "synthetic-family-1", exposure: "public", held_out_eligible: false, source_fixes: [{ upstream: "synthetic-upstream", commit: "a".repeat(40) }], mutation_ids: [mutationId] }] }),
      ),
      heldOut: write(join(dir, "inputs", "held-out.json"), canonical({ schema_version: 1, family_ids: [], source_fixes: [], mutation_ids: [] })),
      sources: w.sources,
      controllerImage: CONTROLLER_IMAGE,
      localStore: privateStore,
      out: releaseDir,
    },
    { docker: w.docker, clock: w.clock, rates: await loadRateSheet(RATE_SHEET_PATH), env: {}, privateStoreFromEnv: () => fail("local mode asked for the real store"), log: () => undefined },
  );
  if (!built.ok) fail(`build refused: ${built.codes.join(",")}`);
  const released = await runCli(["release", "--policy", w.policy.file, "--release-dir", releaseDir, "--state", d.state, "--patterns", w.patterns, ...d.flags]);
  if (released.code !== 0) fail(`release exited ${String(released.code)}`);

  rmSync(out, { recursive: true, force: true });
  checkout(d.remote, "runs", join(out, "repository", "runs"));
  checkout(d.remote, "releases", join(out, "repository", "releases"));
  for (const [from, to] of [[d.store, "store"], [privateStore, "private-store"]] as const) {
    for (const path of readdirSync(from, { recursive: true, encoding: "utf8" }).sort()) {
      if (statSync(join(from, path)).isFile()) write(join(out, to, path), readFileSync(join(from, path)));
    }
  }
  write(join(out, "inputs", "policy.json"), w.policy.bytes);
  write(join(out, "inputs", "root-run.json"), readFileSync(factory.rootRunFile));
  write(join(out, "inputs", "publication.json"), readFileSync(publication));
  write(join(out, "inputs", "release-id.txt"), `${RELEASE_ID}\n`);
}

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (values.out === undefined) {
  process.stderr.write("usage: node scripts/release-fixture.ts --out <dir>\n");
  process.exit(2);
}
try {
  await releaseFixture(resolve(values.out));
} finally {
  cleanupTempDirs();
}
