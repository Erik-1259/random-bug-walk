import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, sha256Hex } from "@rbw/schema";
import { readResults } from "../../../../packages/web/src/release.ts";
import { checkRelease } from "../../src/check.ts";

const FIXTURE = new URL("../../fixtures/release/", import.meta.url).pathname;

describe("the synthetic results directory for the results site", () => {
  it("is read unchanged by the web's readResults: one completed factory root with its admission records", async () => {
    const results = await readResults(FIXTURE);
    expect(results.runs).toHaveLength(1);
    const [run] = results.runs;
    expect(run?.kind).toBe("factory");
    expect(run?.outcome).toBe("completed");
    expect(run?.publicationStatus).toBe("published");
    expect(run?.symptom).not.toBeNull();
    expect(run?.admission?.decision.outcome_verdict).toBe("pass");
    expect(run?.admission?.decision.comparison?.classification).toBe("blind_spot_demonstrated");
    expect(results.caseRun?.rootExecutionId).toBe(run?.rootExecutionId);
  });

  it("holds a release of that root that passes checkRelease, and its judge job's index in the local store", () => {
    const inputs = join(FIXTURE, "inputs");
    const publication = parseRecord("PublicationRecord", readFileSync(join(inputs, "publication.json")));
    const rootRun = parseRecord("RootRun", readFileSync(join(inputs, "root-run.json")));
    const releaseDir = join(FIXTURE, "repository", "releases", readFileSync(join(inputs, "release-id.txt"), "utf8").trim());
    const release = parseRecord("Release", readFileSync(join(releaseDir, "release.json")));
    expect(release.run.root_execution_id).toBe(rootRun.root_execution_id);
    const runDir = join(FIXTURE, "repository", "runs", rootRun.root_execution_id);
    expect(checkRelease(release, { dir: runDir, policyBytes: readFileSync(join(inputs, "policy.json")), publication, rootRun }, releaseDir)).toEqual([]);
    expect(sha256Hex(readFileSync(join(FIXTURE, "private-store", release.judge_job.index_key)))).toBe(release.judge_job.index_sha256);
  });
});
