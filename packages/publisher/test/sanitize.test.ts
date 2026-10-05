import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "../src/errors.ts";
import { parseRedactionValues, sanitize, type RedactionValue } from "../src/sanitize.ts";
import {
  AGENT_LOG,
  COOKIE_SECRET,
  HEADER_SECRET,
  LISTED_PROVIDER_VALUE,
  LISTED_VALUE,
  allBytes,
  allRepositoryBytes,
  commitCount,
  createWorld,
  listFiles,
  printed,
  publish,
  readPublished,
  sha256,
  stage,
  statusObject,
  writeFakeScanner,
  writeRootRun,
  write,
  ROOT_ID,
  PROJECT_ID,
  CHILD_ID,
  defaultOmissions,
} from "./support.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const values = (...pairs: [RedactionValue["category"], string][]): RedactionValue[] =>
  pairs.map(([category, value]) => ({ category, value: bytes(value) }));
const run = (input: string | Buffer, list: RedactionValue[] = []): { text: string; counts: Record<string, number> } => {
  const result = sanitize(typeof input === "string" ? bytes(input) : input, list);
  return { text: Buffer.from(result.bytes).toString("latin1"), counts: result.counts };
};

describe("header rule", () => {
  it("redacts authorization and cookie headers, keeping the name, colon and line ending", () => {
    const secret = HEADER_SECRET;
    const input = [
      `Authorization: Bearer ${secret}\r\n`,
      `  > cookie: a=${COOKIE_SECRET}\n`,
      `< Set-Cookie : id=${secret}; Path=/\n`,
      `\tPROXY-AUTHORIZATION:\tBasic ${secret}\n`,
      "Authorization:   \n",
      "Authorization:\n",
      `X-Authorization: ${secret}\n`,
      `"authorization": "${secret}"\n`,
      `Cookie: last-line-without-newline`,
    ].join("");
    const { text, counts } = run(input);
    expect(text).toBe(
      [
        "Authorization: [redacted:auth_header]\r\n",
        "  > cookie: [redacted:auth_header]\n",
        "< Set-Cookie : [redacted:auth_header]\n",
        "\tPROXY-AUTHORIZATION: [redacted:auth_header]\n",
        "Authorization:   \n",
        "Authorization:\n",
        `X-Authorization: ${secret}\n`,
        `"authorization": "${secret}"\n`,
        "Cookie: [redacted:auth_header]",
      ].join(""),
    );
    expect(counts).toEqual({ auth_header: 5 });
  });

  it("leaves a file that is not valid UTF-8 to the values rule", () => {
    const input = Buffer.concat([bytes(`Authorization: Bearer x ${LISTED_VALUE}\n`), Buffer.from([0xff, 0xfe, 0x0a])]);
    const result = sanitize(input, values(["credential", LISTED_VALUE]));
    expect(Buffer.from(result.bytes).equals(Buffer.concat([bytes("Authorization: Bearer x [redacted:credential]\n"), Buffer.from([0xff, 0xfe, 0x0a])]))).toBe(true);
    expect(result.counts).toEqual({ credential: 1 });
  });

  it("keeps a byte-order mark and every other byte", () => {
    const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes("plain  \r\n\tline\r\n")]);
    expect(Buffer.from(sanitize(input, []).bytes).equals(input)).toBe(true);
  });
});

describe("values rule", () => {
  it("replaces exact case-sensitive matches left to right with the longest value", () => {
    const list = values(["credential", "abc"], ["provider_identifier", "abcdef"], ["private_material", "def"]);
    const { text, counts } = run("abcdef ABC abc defabc abcde", list);
    expect(text).toBe("[redacted:provider_identifier] ABC [redacted:credential] [redacted:private_material][redacted:credential] [redacted:credential]de");
    expect(counts).toEqual({ provider_identifier: 1, credential: 3, private_material: 1 });
  });

  it("never rematches inserted text", () => {
    const list = values(["credential", "redacted"], ["private_material", "x"]);
    const { text, counts } = run("x redacted", list);
    expect(text).toBe("[redacted:private_material] [redacted:credential]");
    expect(counts).toEqual({ private_material: 1, credential: 1 });
  });

  it("never matches inside a marker the header rule inserted", () => {
    const { text, counts } = run("Authorization: Bearer x\nauth_header\n", values(["credential", "auth_header"]));
    expect(text).toBe("Authorization: [redacted:auth_header]\n[redacted:credential]\n");
    expect(counts).toEqual({ auth_header: 1, credential: 1 });
  });

  it("applies after the header rule", () => {
    const { text, counts } = run(`Authorization: ${LISTED_VALUE}\nbody ${LISTED_VALUE}\n`, values(["credential", LISTED_VALUE]));
    expect(text).toBe("Authorization: [redacted:auth_header]\nbody [redacted:credential]\n");
    expect(counts).toEqual({ auth_header: 1, credential: 1 });
  });
});

describe("redaction values file", () => {
  it("parses categories and values, ignoring comments and blank lines and dropping a final CR", () => {
    const parsed = parseRedactionValues(bytes(`# comment\n\ncredential\t${LISTED_VALUE}\r\nprovider_identifier\tid with\ttab\n`));
    expect(parsed.map((item) => [item.category, Buffer.from(item.value).toString("utf8")])).toEqual([
      ["credential", LISTED_VALUE],
      ["provider_identifier", "id with\ttab"],
    ]);
  });

  it.each([
    ["an unknown category", `password\t${LISTED_VALUE}\n`],
    ["a missing tab", `credential ${LISTED_VALUE}\n`],
    ["an empty value", "credential\t\n"],
    ["one value under two categories", `credential\t${LISTED_VALUE}\nprivate_material\t${LISTED_VALUE}\n`],
    ["invalid UTF-8", Buffer.from([0x63, 0x09, 0xff, 0x0a])],
  ])("refuses %s without echoing the value", (_label, input) => {
    let caught: unknown;
    try {
      parseRedactionValues(typeof input === "string" ? bytes(input) : input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidInput);
    expect((caught as Error).message).not.toContain(LISTED_VALUE);
  });
});

describe("sanitizing during publication", () => {
  it("publishes markers, merges declared redactions and keeps every other byte", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(0);
    const { manifest, files } = readPublished(world);
    expect(files.get(AGENT_LOG)?.toString("latin1")).toBe(
      [
        "start\n",
        "Authorization: [redacted:auth_header]\r\n",
        "> cookie: [redacted:auth_header]\n",
        "token [redacted:credential] end   \n",
        'json {"authorization": "kept-for-the-values-rule"}\n',
        "Authorization:   \n",
        "done",
      ].join(""),
    );
    expect(manifest.entries.find((entry) => entry.path === AGENT_LOG)?.redactions).toEqual([
      { category: "auth_header", count: 2 },
      { category: "credential", count: 2 },
    ]);
    const secrets = [LISTED_VALUE, LISTED_PROVIDER_VALUE, HEADER_SECRET, COOKIE_SECRET];
    const surfaces = Buffer.concat([
      Buffer.from(result.stdout + result.stderr),
      allBytes(world.state),
      allBytes(world.store),
      allRepositoryBytes(world.remote),
      Buffer.from(JSON.stringify(statusObject(world))),
    ]).toString("latin1");
    for (const secret of secrets) {
      expect(surfaces).not.toContain(secret);
      expect(surfaces).not.toContain(sha256(secret));
      expect(surfaces).not.toContain(sha256(`${secret}\n`));
    }
  });

  it("freezes identical bytes and the same manifest hash in two fresh state directories", async () => {
    const world = createWorld();
    stage(world.staging);
    const rootRun = writeRootRun(world);
    const unavailable = ["--scanner", writeFakeScanner(world.dir, "exit2")];
    const first = await publish(world, rootRun, [...unavailable, "--state", join(world.dir, "private", "state-a")]);
    const second = await publish(world, rootRun, [...unavailable, "--state", join(world.dir, "private", "state-b")]);
    expect(printed(first).manifest_sha256).toBe(printed(second).manifest_sha256);
    expect(printed(first).publication_id).toBe(printed(second).publication_id);
    const a = join(world.dir, "private", "state-a");
    const b = join(world.dir, "private", "state-b");
    const frozenA = listFiles(a).filter((path) => !path.endsWith("limits.json"));
    expect(listFiles(b).filter((path) => !path.endsWith("limits.json"))).toEqual(frozenA);
    for (const path of frozenA) expect(readFileSync(join(b, path)).equals(readFileSync(join(a, path)))).toBe(true);
  });

  it("exits 4 for a malformed values file without echoing it", async () => {
    const world = createWorld();
    stage(world.staging);
    writeFileSync(world.values, `credential\t${LISTED_VALUE}\nprivate_material\t${LISTED_VALUE}\n`);
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(4);
    expect(result.stdout + result.stderr).not.toContain(LISTED_VALUE);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("exits 4 for a staged path that contains a listed value without echoing the path", async () => {
    const world = createWorld();
    stage(world.staging, { extra: { [`logs/${LISTED_VALUE}.log`]: "content\n" } });
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(4);
    expect(result.stdout + result.stderr).not.toContain(LISTED_VALUE);
    expect(listFiles(world.store)).toEqual([]);
  });

  it("exits 4 for a missing values file", async () => {
    const world = createWorld();
    stage(world.staging);
    const result = await publish(world, writeRootRun(world), ["--redaction-values", join(world.dir, "absent-values.txt")]);
    expect(result.code).toBe(4);
  });
});

describe("sanitizer cost", () => {
  it("handles a log of 100k lines in linear time", () => {
    const input = Buffer.from("plain log line with some ordinary text in it\n".repeat(100_000));
    const started = performance.now();
    const result = sanitize(input, values(["credential", "never-present-value"]));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Buffer.from(result.bytes).equals(input)).toBe(true);
  });
});

describe("listed values outside paths", () => {
  it("refuses a withheld entry whose trial ID contains a listed value, without echoing it", async () => {
    const world = createWorld();
    const omissions = defaultOmissions() as { entries: { trial_id: string | null; outcome: string }[] };
    const withheld = omissions.entries.find((entry) => entry.outcome === "withheld_private");
    if (withheld === undefined) throw new Error("expected a withheld entry");
    withheld.trial_id = LISTED_VALUE;
    stage(world.staging, { omissions });
    const result = await publish(world, writeRootRun(world));
    expect(result.code).toBe(4);
    expect(result.stdout + result.stderr).not.toContain(LISTED_VALUE);
    expect(listFiles(world.store)).toEqual([]);
    expect(commitCount(world.remote)).toBe(0);
  });

  it("refuses declared stages that contain a listed value, without echoing it", async () => {
    const world = createWorld();
    const stageValue = ["synthetic", "private", "stage"].join("_");
    writeFileSync(world.values, `${readFileSync(world.values, "utf8")}provider_identifier\t${stageValue}\n`);
    stage(world.staging);
    const rootRun = write(
      join(world.dir, "private", "root-run-stages.json"),
      JSON.stringify({
        schema_version: 1,
        project_id: PROJECT_ID,
        root_execution_id: ROOT_ID,
        project_policy_sha256: world.policySha256,
        kind: "factory",
        declared_stages: ["prepare", stageValue],
        child_execution_ids: [CHILD_ID],
        status: "terminal",
        outcome: "completed",
      }),
    );
    const result = await publish(world, rootRun);
    expect(result.code).toBe(4);
    expect(result.stdout + result.stderr).not.toContain(stageValue);
    expect(commitCount(world.remote)).toBe(0);
  });
});
