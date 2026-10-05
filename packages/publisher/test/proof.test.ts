import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPolicy } from "@rbw/schema";
import { runCli } from "../src/cli.ts";
import { runProof, type ProofDeps } from "../scripts/proof.ts";
import { GITHUB_REPOSITORY, PROJECT_ID, createWorld, harness, write } from "./support.ts";

const STORE_BASE = "https://synthetic-store.example.invalid/test-prefix/";

describe("integration proof script", () => {
  it("passes every scenario in local mode", async () => {
    const world = createWorld();
    const lines: string[] = [];
    const deps: ProofDeps = {
      publish: (argv) => runCli(argv, { env: { PATH: process.env.PATH ?? "", HOME: world.dir } }),
      readUrl: (url) => url,
      fetch: () => Promise.reject(new Error("local mode reads no URL")),
      print: (line) => lines.push(line),
    };
    const code = await runProof({ work: join(world.dir, "proof"), patterns: null, scanner: null, gitleaks: world.gitleaks, real: null }, deps);
    expect(lines.filter((line) => line.startsWith("scenario=")).map((line) => line.split(" ").at(-1))).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(lines).toContain("status count published 1");
    expect(lines).toContain("status count blocked 1");
    expect(code).toBe(0);
  });

  it("wires real mode through the policy's destinations with injected clients", async () => {
    const world = createWorld();
    const policyFile = join(world.dir, "private", "real-policy.json");
    writeFileSync(policyFile, buildPolicy({ projectId: PROJECT_ID, outputRepository: GITHUB_REPOSITORY, publicArtifactBaseUri: STORE_BASE, policyVersion: 1 }).bytes);
    const keyFile = write(join(world.dir, "keys", "deploy-key"), ["synthetic", "key", "placeholder"].join("-"));
    chmodSync(keyFile, 0o600);
    const fake = harness(world.remote);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: world.dir,
      RBW_RESULTS_DEPLOY_KEY_FILE: keyFile,
      RBW_PUBLIC_STORE_TOKEN: ["synthetic", "store", "placeholder"].join("-"),
    };
    const argvSeen: string[][] = [];
    const lines: string[] = [];
    const deps: ProofDeps = {
      publish: (argv) => {
        argvSeen.push(argv);
        return runCli(argv, { env, runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
      },
      readUrl: (url) => (url === GITHUB_REPOSITORY ? world.remote : url),
      fetch: fake.fetch,
      print: (line) => lines.push(line),
    };
    const code = await runProof(
      { work: join(world.dir, "proof"), patterns: null, scanner: null, gitleaks: world.gitleaks, real: { policyFile, branch: "synthetic-proof-branch" } },
      deps,
    );
    expect(lines.filter((line) => line.startsWith("scenario=")).map((line) => line.split(" ").at(-1))).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(code).toBe(0);
    const publishes = argvSeen.filter((argv) => argv[0] === "publish");
    expect(publishes).toHaveLength(4);
    for (const argv of publishes) {
      expect(argv).toContain("--real");
      expect(argv[argv.indexOf("--repository-url") + 1]).toBe(GITHUB_REPOSITORY);
      expect(argv[argv.indexOf("--artifact-base-uri") + 1]).toBe(STORE_BASE);
      expect(argv[argv.indexOf("--branch") + 1]).toBe("synthetic-proof-branch");
      expect(argv).not.toContain("--local-remote");
    }
    expect(fake.calls.some((call) => call.args.includes("push") && call.args.includes("git@github.com:synthetic-owner/synthetic-results.git"))).toBe(true);
    expect(fake.puts.filter((put) => put.pathname.startsWith("test-prefix/sha256/"))).toHaveLength(1);
  });
});
