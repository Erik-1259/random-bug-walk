import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rbw/schema";
import { PROBE_DIR, loadProbeSet } from "@rbw/shapes";
import { ALTERNATIVE_FIX_DIR } from "@rbw/local-runner";
import type { Docker } from "@rbw/local-runner";
import { PROOF_DIR, ProofInputError, loadProofInputs, runProof } from "../../src/proof.ts";
import type { ProofOptions } from "../../src/proof.ts";
import { FakeDocker } from "../../../local-runner/test/support/fakes.ts";
import { ALTERNATIVE, ALTERNATIVE_PATCH, PARTIAL, PARTIAL_PATCH, PLANTED, TARGET, sha256, tempDir } from "../../../local-runner/test/support/synthetic.ts";
import { jobInputs, world } from "../support/harness.ts";
import type { World } from "../support/harness.ts";

const MARKER = "synthetic-forged-pass";
const FORGED = PLANTED.replace("  const unit = 'day';\n", `  const unit = 'day';\n  writeFileSync('/var/tmp/rbw-app/report.json', '${MARKER}');\n`);
const FORGERY_PATCH = `diff --git a/${TARGET} b/${TARGET}\n--- a/${TARGET}\n+++ b/${TARGET}\n@@ -1,5 +1,6 @@
 // synthetic target for local-runner tests
 export function synthetic(zone: string) {
   const unit = 'day';
+  writeFileSync('/var/tmp/rbw-app/report.json', '${MARKER}');
   return range(unit);
 }
`;

/** A proof directory in the committed layout, over the synthetic target file. */
function syntheticProofDir(valid: { patch: string; result: string } = { patch: ALTERNATIVE_PATCH, result: ALTERNATIVE }): string {
  const dir = tempDir("rbw-controller-proof-");
  writeFileSync(join(dir, "valid-fix.patch"), valid.patch);
  writeFileSync(join(dir, "empty-fix.patch"), "");
  writeFileSync(join(dir, "forgery.patch"), FORGERY_PATCH);
  const inputs = {
    schema_version: 1,
    target_path: TARGET,
    base_sha256: sha256(PLANTED),
    cases: {
      valid_fix: { patch: "valid-fix.patch", patch_sha256: sha256(valid.patch), result_sha256: sha256(valid.result) },
      empty_fix: { patch: "empty-fix.patch", patch_sha256: sha256(""), result_sha256: sha256(PLANTED) },
      forgery: { patch: "forgery.patch", patch_sha256: sha256(FORGERY_PATCH), result_sha256: sha256(FORGED) },
    },
    forgery_marker: MARKER,
  };
  writeFileSync(join(dir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
  return dir;
}

/**
 * The simulated app answers by the placed file's hash and knows nothing of the forgery, so this
 * Docker layer places the planted file in its stead: the forgery leaves the planted bug in place,
 * and its writes land only where the app can write, which the simulated copy never reads.
 */
function forgeryRunsAsPlanted(inner: Docker): Docker {
  const planted = join(tempDir("rbw-controller-forgery-"), "planted.ts");
  writeFileSync(planted, PLANTED);
  return new FakeDocker((args, options) => {
    const from = String(args[1]);
    if (args[0] === "cp" && String(args[2]).includes(":/workspace/app/") && existsSync(from) && readFileSync(from, "utf8") === FORGED) {
      return inner.run(["cp", planted, String(args[2])], options);
    }
    return inner.run(args, options);
  });
}

function proofOptions(w: World, proofDir: string): ProofOptions {
  const inputs = jobInputs(w, { backend: "docker", sandboxImage: null });
  return {
    work: inputs.work,
    image: inputs.image,
    manifest: inputs.manifest,
    terms: inputs.terms,
    policy: inputs.policy,
    kitStage: inputs.kitStage,
    originalSuite: inputs.originalSuite,
    ...(inputs.probesDir === undefined ? {} : { probesDir: inputs.probesDir }),
    backend: inputs.backend,
    sandboxImage: inputs.sandboxImage,
    proofDir,
  };
}

describe("the committed grader-proof inputs", () => {
  it("pins each patch by its hash, over the planted file of the probes", () => {
    const inputs = loadProofInputs(PROOF_DIR);
    const probes = loadProbeSet(PROBE_DIR);
    expect(inputs.target_path).toBe(probes.data.target_path);
    expect(inputs.base_sha256).toBe(probes.data.planted_sha256);
    for (const item of Object.values(inputs.cases)) expect(sha256Hex(Buffer.from(item.patch_text))).toBe(item.patch_sha256);
    expect(inputs.cases.empty_fix).toMatchObject({ patch_text: "", patch_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", result_sha256: probes.data.planted_sha256 });
    expect(inputs.cases.valid_fix.patch_sha256).toBe("eb9f8e138949a36338dfcc99427d560f998f7584b4b2112d152411303dc9f5c3");
    expect(inputs.cases.forgery.patch_sha256).toBe("fa97cef81d37af3ad6cc634d414d0222261de5a7a9f6a8d09710a6be2aaaba48");
    const alternative = JSON.parse(readFileSync(join(ALTERNATIVE_FIX_DIR, "alternative-fix.json"), "utf8")) as { result_sha256: string };
    expect(inputs.cases.valid_fix.result_sha256).toBe(alternative.result_sha256);
    expect(inputs.cases.valid_fix.result_sha256).not.toBe(probes.data.clean_sha256);
    expect(inputs.cases.forgery.patch_text).toContain(inputs.forgery_marker);
    expect(inputs.cases.forgery.patch_text).not.toMatch(/^-(?!--)/m);
  });

  it("refuses a patch whose bytes differ from its pinned hash", () => {
    const dir = syntheticProofDir();
    writeFileSync(join(dir, "forgery.patch"), `${FORGERY_PATCH}\n`);
    expect(() => loadProofInputs(dir)).toThrow(ProofInputError);
  });
});

describe("the grader proof against the fake backend", () => {
  it("passes the valid fix, fails the empty fix as declared, grades the forgery only from the verifier's records, and never passes a tampered regrade", async () => {
    const w = await world({ docker: (inner) => forgeryRunsAsPlanted(inner) });
    const result = await runProof(proofOptions(w, syntheticProofDir()), w.deps);
    const byCase = Object.fromEntries(result.cases.map((item) => [item.case, item]));
    expect(byCase.valid_fix).toMatchObject({ ok: true, trial_id: "fixed-01", placed_sha256: sha256(ALTERNATIVE), observed: { status: "complete", added_verdict: "match", original_failed: 0 } });
    expect(byCase.empty_fix).toMatchObject({ ok: true, trial_id: "planted-01", placed_sha256: sha256(PLANTED), observed: { status: "complete", added_verdict: "match" } });
    expect(byCase.forgery).toMatchObject({ ok: true, trial_id: "fixed-01", placed_sha256: sha256(FORGED), observed: { status: "complete", added_verdict: "reject", marker_found: false } });
    expect(byCase.protected_regrade).toMatchObject({ ok: true, trial_id: "fixed-01" });
    expect(byCase.protected_regrade?.regrades.map((item) => [item.tamper, item.status, item.code])).toEqual([
      ["records_missing", "incomplete", "import:result_missing"],
      ["records_altered", "invalid", "import:shape_observations"],
    ]);
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(result.proofPath, "utf8")) as { cases: { case: string; patch_sha256: string }[] };
    expect(written.cases.map((item) => [item.case, item.patch_sha256])).toEqual([
      ["valid_fix", sha256(ALTERNATIVE_PATCH)],
      ["empty_fix", sha256("")],
      ["forgery", sha256(FORGERY_PATCH)],
      ["protected_regrade", sha256(ALTERNATIVE_PATCH)],
    ]);
    expect(result.jobs.map((job) => [job.name, job.status])).toEqual([
      ["proof-fix", "complete"],
      ["proof-forgery", "complete"],
    ]);
  });

  it("reports a failed proof when the valid fix does not pass every check", async () => {
    const w = await world();
    const result = await runProof(proofOptions(w, syntheticProofDir({ patch: PARTIAL_PATCH, result: PARTIAL })), w.deps);
    const byCase = Object.fromEntries(result.cases.map((item) => [item.case, item]));
    expect(byCase.valid_fix).toMatchObject({ ok: false, observed: { added_verdict: "reject" } });
    expect(byCase.protected_regrade?.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
