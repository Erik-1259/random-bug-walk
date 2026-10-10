import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPolicy } from "@rbw/schema";
import type { BlobClient } from "../src/store.ts";
import {
  PROJECT_ID,
  allBytes,
  allRepositoryBytes,
  commitCount,
  createWorld,
  harness,
  listFiles,
  printed,
  publish,
  stage,
  write,
  writeRootRun,
  GITHUB_REPOSITORY,
  SSH_REMOTE,
  type World,
} from "./support.ts";
import { runCli } from "../src/cli.ts";

const STORE_BASE = "https://synthetic-store.example.invalid/test-prefix/";
const KEY_VARIABLE = "RBW_RESULTS_DEPLOY_KEY_FILE";
const STORE_ID_VARIABLE = "BLOB_PUBLIC_STORE_ID";
const OIDC_VARIABLE = "VERCEL_OIDC_TOKEN";

// Low-entropy placeholders without any real token prefix, assembled at runtime.
const STORE_ID = ["synthetic", "public", "store", "placeholder"].join("-");
const OIDC_TOKEN = ["synthetic", "oidc", "credential", "placeholder"].join("-");
const KEY_CONTENT = ["synthetic", "deploy", "key", "placeholder"].join("-");

interface RealWorld extends World {
  keyFile: string;
  rootRun: string;
}

function realWorld(): RealWorld {
  const world = createWorld();
  const built = buildPolicy({ projectId: PROJECT_ID, outputRepository: GITHUB_REPOSITORY, publicArtifactBaseUri: STORE_BASE, policyVersion: 1 });
  writeFileSync(world.policyFile, built.bytes);
  world.policySha256 = built.sha256;
  const keyFile = write(join(world.dir, "keys", "deploy-key"), `${KEY_CONTENT}\n`);
  chmodSync(keyFile, 0o600);
  stage(world.staging);
  return { ...world, keyFile, rootRun: writeRootRun(world) };
}

function realArgv(world: RealWorld, extra: string[] = []): string[] {
  return [
    "publish",
    "--real",
    "--policy",
    world.policyFile,
    "--root-run",
    world.rootRun,
    "--staging",
    world.staging,
    "--state",
    world.state,
    "--patterns",
    world.patterns,
    "--redaction-values",
    world.values,
    "--repository-url",
    GITHUB_REPOSITORY,
    "--artifact-base-uri",
    STORE_BASE,
    "--gitleaks",
    world.gitleaks,
    "--large-threshold-bytes",
    "1024",
    ...extra,
  ];
}

function realEnv(world: RealWorld): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: world.dir, [KEY_VARIABLE]: world.keyFile, [STORE_ID_VARIABLE]: STORE_ID, [OIDC_VARIABLE]: OIDC_TOKEN };
}

describe("credential containment", () => {
  it("never reads any credential variable in local mode", async () => {
    const world = createWorld();
    stage(world.staging);
    const read = new Set<string>();
    const source: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: world.dir,
      [KEY_VARIABLE]: join(world.dir, "absent-key"),
      [STORE_ID_VARIABLE]: STORE_ID,
      [OIDC_VARIABLE]: OIDC_TOKEN,
    };
    const env = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string") read.add(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = await publish(world, writeRootRun(world), [], { env });
    expect(result.code).toBe(0);
    expect(read.has(KEY_VARIABLE)).toBe(false);
    expect(read.has(STORE_ID_VARIABLE)).toBe(false);
    expect(read.has(OIDC_VARIABLE)).toBe(false);
  });

  it("passes the deploy key only to the push process and the store ID and OIDC token only to the store client", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const result = await runCli(realArgv(world), { env: realEnv(world), runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.stderr).not.toContain("internal error");
    expect(result.code).toBe(0);
    expect(printed(result).status).toBe("published");
    expect(commitCount(world.remote)).toBe(1);

    const pushes = fake.calls.filter((call) => call.command === "git" && call.args.includes("push"));
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(push?.args).toContain(SSH_REMOTE);
    const ssh = push?.env.GIT_SSH_COMMAND ?? "";
    expect(ssh).toContain(`-i '${world.keyFile}'`);
    for (const option of ["-o IdentitiesOnly=yes", "-o BatchMode=yes", "-F /dev/null", "-o StrictHostKeyChecking=yes", "-o UserKnownHostsFile="]) {
      expect(ssh).toContain(option);
    }
    expect(ssh).toContain("github_known_hosts");

    for (const call of fake.calls) {
      const argv = [call.command, ...call.args].join("\n");
      expect(argv).not.toContain(world.keyFile);
      expect(argv).not.toContain(KEY_CONTENT);
      expect(argv).not.toContain(STORE_ID);
      expect(argv).not.toContain(OIDC_TOKEN);
      const envText = Object.entries(call.env)
        .filter(([name]) => !(call === push && name === "GIT_SSH_COMMAND"))
        .map(([name, value]) => `${name}=${value}`)
        .join("\n");
      expect(envText).not.toContain(world.keyFile);
      expect(envText).not.toContain(KEY_CONTENT);
      expect(envText).not.toContain(STORE_ID);
      expect(envText).not.toContain(OIDC_TOKEN);
      expect(Object.keys(call.env)).not.toContain(KEY_VARIABLE);
      expect(Object.keys(call.env)).not.toContain(STORE_ID_VARIABLE);
      expect(Object.keys(call.env)).not.toContain(OIDC_VARIABLE);
      if (call.command === "git") {
        expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1");
        expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(Object.keys(call.env).filter((name) => name.startsWith("GIT_TRACE"))).toEqual([]);
        expect(call.args).toContain("core.hooksPath=/dev/null");
        expect(call.args).toContain("credential.helper=");
      }
    }
    // Reads of the repository use the public URL without credentials.
    expect(fake.calls.some((call) => call.args.includes("fetch") && call.args.includes(GITHUB_REPOSITORY))).toBe(true);

    expect(fake.puts.length).toBeGreaterThanOrEqual(2);
    for (const put of fake.puts) {
      expect(put.options.storeId).toBe(STORE_ID);
      expect(put.options.oidcToken).toBe(OIDC_TOKEN);
      expect(put.options).not.toHaveProperty("token");
      expect(put.options.access).toBe("public");
      expect(put.options.addRandomSuffix).toBe(false);
      expect(put.pathname.startsWith("test-prefix/")).toBe(true);
    }
    const objectPut = fake.puts.find((put) => put.pathname.startsWith("test-prefix/sha256/"));
    expect(objectPut?.options.allowOverwrite).toBe(false);
    const statusPut = fake.puts.find((put) => put.pathname.startsWith("test-prefix/status/"));
    expect(statusPut?.options.allowOverwrite).toBe(true);
    expect(statusPut?.options.cacheControlMaxAge).toBe(60);
    for (const request of fake.fetches) {
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
      expect(Object.values(request.headers).join("\n")).not.toContain(OIDC_TOKEN);
    }

    const everything = Buffer.concat([
      Buffer.from(result.stdout + result.stderr),
      allBytes(world.state),
      allRepositoryBytes(world.remote),
      ...[...fake.objects.values()].map((bytes) => Buffer.from(bytes)),
    ]).toString("latin1");
    for (const secret of [STORE_ID, OIDC_TOKEN, KEY_CONTENT, world.keyFile]) expect(everything).not.toContain(secret);
  });

  // Store credentials that the SDK or an earlier version of the publisher would read never stand in for the two variables.
  const otherTokens = {
    RBW_PUBLIC_STORE_TOKEN: ["synthetic", "old", "token", "placeholder"].join("-"),
    BLOB_READ_WRITE_TOKEN: ["synthetic", "read", "write", "placeholder"].join("-"),
    BLOB_STORE_ID: ["synthetic", "default", "store", "placeholder"].join("-"),
  };

  it.each([
    ["the deploy key variable is unset", "deploy_key_unset", (world: RealWorld) => ({ ...realEnv(world), [KEY_VARIABLE]: undefined })],
    ["the store ID is unset", "store_id_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [STORE_ID_VARIABLE]: undefined })],
    ["the store ID is empty", "store_id_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [STORE_ID_VARIABLE]: "" })],
    ["the store ID is blank", "store_id_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [STORE_ID_VARIABLE]: "  " })],
    ["the OIDC token is unset", "oidc_token_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [OIDC_VARIABLE]: undefined })],
    ["the OIDC token is empty", "oidc_token_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [OIDC_VARIABLE]: "" })],
    ["the OIDC token is blank", "oidc_token_unset", (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [OIDC_VARIABLE]: " " })],
    [
      "only other store credentials are set",
      "store_id_unset",
      (world: RealWorld) => ({ ...realEnv(world), ...otherTokens, [STORE_ID_VARIABLE]: undefined, [OIDC_VARIABLE]: undefined }),
    ],
    [
      "the deploy key is readable by others",
      "deploy_key_permissions",
      (world: RealWorld) => {
        chmodSync(world.keyFile, 0o644);
        return realEnv(world);
      },
    ],
    ["the deploy key lies inside the state directory", "deploy_key_missing", (world: RealWorld) => ({ ...realEnv(world), [KEY_VARIABLE]: join(world.state, "key") })],
    [
      "the deploy key lies inside staging",
      "deploy_key_location",
      (world: RealWorld) => {
        const inside = write(join(world.staging, "inputs", "key"), KEY_CONTENT);
        chmodSync(inside, 0o600);
        return { ...realEnv(world), [KEY_VARIABLE]: inside };
      },
    ],
  ])("exits 4 when %s", async (_label, code, makeEnv) => {
    const world = realWorld();
    const fake = harness(world.remote);
    const env = Object.fromEntries(Object.entries(makeEnv(world)).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await runCli(realArgv(world), { env, runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(`invalid input: ${code}\n`);
    for (const secret of [KEY_CONTENT, STORE_ID, OIDC_TOKEN, ...Object.values(otherTokens)]) expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fake.calls).toEqual([]);
    expect(fake.puts).toEqual([]);
    expect(fake.fetches).toEqual([]);
    expect(existsSync(join(world.state, "roots"))).toBe(false);
  });

  it("uses a configured deploy key variable name", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const env = { PATH: process.env.PATH ?? "", HOME: world.dir, SYNTHETIC_KEY_PATH: world.keyFile, [STORE_ID_VARIABLE]: STORE_ID, [OIDC_VARIABLE]: OIDC_TOKEN };
    const result = await runCli(realArgv(world, ["--deploy-key-env", "SYNTHETIC_KEY_PATH"]), {
      env,
      runner: fake.runner,
      blobClient: fake.blobClient,
      fetch: fake.fetch,
    });
    expect(result.code).toBe(0);
    expect(fake.calls.find((call) => call.args.includes("push"))?.env.GIT_SSH_COMMAND).toContain(`-i '${world.keyFile}'`);
    expect(fake.puts.every((put) => put.options.storeId === STORE_ID && put.options.oidcToken === OIDC_TOKEN)).toBe(true);
  });

  it("has no flag that renames a store credential variable", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const env = { ...realEnv(world), SYNTHETIC_STORE_SECRET: OIDC_TOKEN };
    const result = await runCli(realArgv(world, ["--store-token-env", "SYNTHETIC_STORE_SECRET"]), { env, runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("invalid input: usage\n");
    expect(fake.calls).toEqual([]);
    expect(fake.puts).toEqual([]);
  });

  it.each([
    ["--deploy-key-env", "LANG"],
    ["--deploy-key-env", "HOME"],
  ])("refuses %s %s, which child processes would inherit", async (flag, name) => {
    const world = realWorld();
    const fake = harness(world.remote);
    const env = { ...realEnv(world), [name]: world.keyFile };
    const result = await runCli(realArgv(world, [flag, name]), { env, runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.code).toBe(4);
    expect(fake.calls).toEqual([]);
  });

  it("has no flag that swaps the committed known-hosts file", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const other = write(join(world.dir, "other_known_hosts"), "synthetic.example.invalid ssh-ed25519 AAAA\n");
    const result = await runCli(realArgv(world, ["--known-hosts", other]), { env: realEnv(world), runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.code).toBe(4);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a real-mode repository outside github.com", async () => {
    const world = realWorld();
    const built = buildPolicy({ projectId: PROJECT_ID, outputRepository: "https://example.invalid/synthetic-owner/synthetic-results", publicArtifactBaseUri: STORE_BASE, policyVersion: 1 });
    writeFileSync(world.policyFile, built.bytes);
    world.policySha256 = built.sha256;
    const rootRun = writeRootRun(world);
    const fake = harness(world.remote);
    const argv = realArgv({ ...world, rootRun }).map((arg) => (arg === GITHUB_REPOSITORY ? "https://example.invalid/synthetic-owner/synthetic-results" : arg));
    const result = await runCli(argv, { env: realEnv(world), runner: fake.runner, blobClient: fake.blobClient, fetch: fake.fetch });
    expect(result.code).toBe(4);
    expect(fake.calls).toEqual([]);
  });

  it("records store_mismatch when the store returns another URL", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const blobClient: BlobClient = {
      put: async (pathname, body, options) => {
        await fake.blobClient.put(pathname, body, options);
        return { url: `https://synthetic-store.example.invalid/elsewhere/${pathname}` };
      },
    };
    const result = await runCli(realArgv(world), { env: realEnv(world), runner: fake.runner, blobClient, fetch: fake.fetch });
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "store_mismatch" });
    expect(commitCount(world.remote)).toBe(0);
  });

  it("records store_unavailable when the store cannot be reached", async () => {
    const world = realWorld();
    const fake = harness(world.remote);
    const failingFetch = (): Promise<Response> => Promise.reject(new Error("synthetic network failure"));
    const result = await runCli(realArgv(world), { env: realEnv(world), runner: fake.runner, blobClient: fake.blobClient, fetch: failingFetch });
    expect(result.code).toBe(2);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "store_unavailable" });
    expect(listFiles(world.store)).toEqual([]);
    expect(readFileSync(world.keyFile, "utf8")).toBe(`${KEY_CONTENT}\n`);
  });
});
