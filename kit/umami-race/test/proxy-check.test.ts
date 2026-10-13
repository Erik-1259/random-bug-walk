import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditLog,
  CHECK_AGENT,
  checkProxies,
  effectiveLatency,
  findMark,
  MARK_AGENT,
  parseLatencyValue,
  readLatencyFile,
  type ExpectedProxy,
} from "../src/proxy-check.ts";
import { PROXY, TOXIC } from "../src/race-manifest.ts";

const script = new URL("../src/proxy-check.ts", import.meta.url).pathname;
const EXPECTED: ExpectedProxy = { name: PROXY.name, listen: PROXY.listen, upstream: PROXY.upstream, toxic: TOXIC.name, latencyMs: 40 };

/** Toxiproxy 2.12.0's GET /proxies answer for the configured proxy, as captured in the race image. */
function configured(latency = 40) {
  return {
    postgres: {
      name: "postgres",
      listen: "127.0.0.1:5433",
      upstream: "127.0.0.1:5432",
      enabled: true,
      toxics: [{ attributes: { latency, jitter: 0 }, name: "latency_downstream", type: "latency", stream: "downstream", toxicity: 1 }],
    },
  };
}

type Proxies = ReturnType<typeof configured>;
const tampered: [string, (proxies: Proxies) => unknown][] = [
  ["toxic deleted", (p) => ({ postgres: { ...p.postgres, toxics: [] } })],
  ["latency changed", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], attributes: { latency: 0, jitter: 0 } }] } })],
  ["jitter non-zero", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], attributes: { latency: 40, jitter: 5 } }] } })],
  ["extra toxic attribute", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], attributes: { latency: 40, jitter: 0, x: 1 } }] } })],
  ["second toxic", (p) => ({ postgres: { ...p.postgres, toxics: [...p.postgres.toxics, { ...p.postgres.toxics[0], name: "other" }] } })],
  ["toxic renamed", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], name: "other" }] } })],
  ["toxic on the upstream stream", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], stream: "upstream" }] } })],
  ["toxic of another type", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], type: "bandwidth" }] } })],
  ["partial toxicity", (p) => ({ postgres: { ...p.postgres, toxics: [{ ...p.postgres.toxics[0], toxicity: 0.5 }] } })],
  ["extra proxy", (p) => ({ ...p, other: { ...p.postgres, name: "other", listen: "127.0.0.1:5434" } })],
  ["proxy renamed", (p) => ({ other: { ...p.postgres, name: "other" } })],
  ["proxy disabled", (p) => ({ postgres: { ...p.postgres, enabled: false } })],
  ["upstream changed", (p) => ({ postgres: { ...p.postgres, upstream: "127.0.0.1:5999" } })],
  ["listen changed", (p) => ({ postgres: { ...p.postgres, listen: "0.0.0.0:5433" } })],
  ["no proxies", () => ({})],
  ["not an object", () => []],
];

describe("checkProxies", () => {
  it("passes the configured proxy and toxic, in any attribute order", () => {
    expect(checkProxies(configured(), EXPECTED)).toEqual([]);
    const reordered = configured();
    reordered.postgres.toxics[0] = { ...reordered.postgres.toxics[0], attributes: { jitter: 0, latency: 40 } } as never;
    expect(checkProxies(reordered, EXPECTED)).toEqual([]);
  });

  it.each(tampered)("fails when the %s", (_name, change) => {
    expect(checkProxies(change(configured()), EXPECTED)).not.toEqual([]);
  });

  it("fails when the toxic's latency is not the one requested for the round", () => {
    expect(checkProxies(configured(40), { ...EXPECTED, latencyMs: 25 })).toEqual([
      expect.stringMatching(/^toxics are .*"latency":40.*expected .*"latency":25/),
    ]);
  });

  it("names each difference", () => {
    const problems = checkProxies({ postgres: { ...configured().postgres, enabled: false, upstream: "127.0.0.1:1" } }, EXPECTED);
    expect(problems).toEqual(["upstream is 127.0.0.1:1, expected 127.0.0.1:5432", "the proxy is disabled"]);
  });
});

describe("latency", () => {
  it("accepts whole milliseconds from 0 to 10000 without a leading zero", () => {
    expect([0, 1, 250, 10000].map((value) => parseLatencyValue(String(value)))).toEqual([0, 1, 250, 10000]);
    for (const value of ["", "-1", "1.5", "007", "10001", "1e3", " 5", "default"]) {
      expect(() => parseLatencyValue(value), value).toThrow(/whole number/);
    }
  });

  it("reads exactly one RBW_RACE_LATENCY_MS line, with comments and blank lines allowed", () => {
    expect(readLatencyFile("# from the build\n\nRBW_RACE_LATENCY_MS=40\n")).toBe(40);
    expect(() => readLatencyFile("RBW_RACE_LATENCY_MS=1\nRBW_RACE_LATENCY_MS=2\n")).toThrow(/only/);
    expect(() => readLatencyFile("RBW_RACE_LATENCY_MS=1\nunset X\n")).toThrow(/only/);
    expect(() => readLatencyFile("")).toThrow(/whole number/);
  });

  it("uses this container's override when root set one, and the image default otherwise", () => {
    expect(effectiveLatency("RBW_RACE_LATENCY_MS=0\n", undefined)).toBe(0);
    expect(effectiveLatency("RBW_RACE_LATENCY_MS=0\n", "RBW_RACE_LATENCY_MS=40\n")).toBe(40);
    expect(() => effectiveLatency("RBW_RACE_LATENCY_MS=0\n", "RBW_RACE_LATENCY_MS=abc\n")).toThrow();
    expect(() => effectiveLatency("broken\n", "RBW_RACE_LATENCY_MS=40\n")).toThrow();
  });
});

/** One API request line as Toxiproxy 2.12.0 writes it. */
function request(method: string, url: string, agent: string, client = "127.0.0.1:40000"): string {
  return `${JSON.stringify({
    level: "debug",
    request_id: "r",
    client,
    method,
    url,
    user_agent: agent,
    status: 200,
    size: 1,
    duration: 0.1,
    handler: "H",
    caller: "api.go:107",
    time: "2026-10-13T14:01:56Z",
  })}\n`;
}
const TRACE = `${JSON.stringify({ level: "trace", component: "ToxicCollection", method: "RemoveToxic", toxic: "latency_downstream", message: "Finished" })}\n`;
const SETUP = [
  `${JSON.stringify({ level: "info", message: "Starting Toxiproxy" })}\n`,
  request("POST", "/proxies", "rbw-proxy"),
  request("DELETE", "/proxies/postgres/toxics/latency_downstream", "rbw-proxy"),
  TRACE,
  request("POST", "/proxies/postgres/toxics", "rbw-proxy"),
  request("GET", "/version", MARK_AGENT),
].join("");
const MARK = Buffer.byteLength(SETUP);
const OWN_CHECK = request("GET", "/proxies", CHECK_AGENT);
const CAP = 16 * 1024 * 1024;
const log = (...lines: string[]) => Buffer.from(SETUP + lines.join(""));

describe("findMark", () => {
  it("returns the offset just after rbw-proxy's mark request, and nothing before it is logged", () => {
    expect(findMark(log(), 0)).toBe(MARK);
    expect(findMark(Buffer.from(SETUP.slice(0, SETUP.lastIndexOf("{"))), 0)).toBeUndefined();
    expect(findMark(log(), MARK)).toBeUndefined();
  });

  it("takes the first mark after the starting offset, so a later copy cannot move the mark past a change", () => {
    const later = log(request("DELETE", "/proxies/postgres/toxics/latency_downstream", "curl"), request("GET", "/version", MARK_AGENT));
    expect(findMark(later, 0)).toBe(MARK);
  });
});

describe("auditLog", () => {
  it("passes when only GETs follow the mark and the check's own request is logged", () => {
    expect(auditLog(log(request("GET", "/proxies", "curl"), TRACE, OWN_CHECK), MARK, CAP)).toEqual({ status: 0, problems: [] });
  });

  it("ignores the writes before the mark", () => {
    expect(auditLog(log(OWN_CHECK), MARK, CAP).status).toBe(0);
  });

  it("fails when a toxic was deleted and put back after the mark, though the state then matches", () => {
    const result = auditLog(
      log(
        request("DELETE", "/proxies/postgres/toxics/latency_downstream", "curl/8.22.0", "127.0.0.1:49096"),
        request("POST", "/proxies/postgres/toxics", "curl/8.22.0"),
        OWN_CHECK,
      ),
      MARK,
      CAP,
    );
    expect(result.status).toBe(1);
    expect(result.problems[0]).toBe("DELETE /proxies/postgres/toxics/latency_downstream from 127.0.0.1:49096 (curl/8.22.0) after the proxy was set");
    expect(result.problems).toHaveLength(2);
  });

  it.each(["POST /reset", "POST /proxies/postgres", "DELETE /proxies/postgres", "PATCH /proxies/postgres", "POST /populate"])(
    "fails on %s, whoever sent it",
    (call) => {
      const [method = "", url = ""] = call.split(" ");
      expect(auditLog(log(request(method, url, "rbw-proxy"), OWN_CHECK), MARK, CAP).status).toBe(1);
    },
  );

  it("waits (status 3) until the check's own GET /proxies is logged", () => {
    expect(auditLog(log(request("GET", "/proxies", "curl")), MARK, CAP).status).toBe(3);
    expect(auditLog(log(OWN_CHECK.slice(0, -1)), MARK, CAP).status).toBe(3);
  });

  it("fails on an unreadable line, a mark past the end and a log at its cap", () => {
    expect(auditLog(log("not json\n", OWN_CHECK), MARK, CAP).status).toBe(1);
    expect(auditLog(log(OWN_CHECK), MARK + 10_000, CAP).status).toBe(1);
    const full = log(OWN_CHECK);
    expect(auditLog(full, MARK, full.length)).toEqual({
      status: 1,
      problems: ["the Toxiproxy log reached its cap, so later API requests are not recorded"],
    });
  });
});

describe("rbw-proxy-check CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "rbw-proxy-check-"));
  const file = (name: string, text: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const run = (args: string[], input = "") => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input });
  const checkArgs = (latency: string) => ["check", PROXY.name, PROXY.listen, PROXY.upstream, TOXIC.name, latency];

  it("check reads the API's JSON on stdin and exits 0 only for the configured state", () => {
    expect(run(checkArgs("40"), JSON.stringify(configured())).status).toBe(0);
    for (const [name, change] of tampered) {
      const result = run(checkArgs("40"), JSON.stringify(change(configured())));
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toMatch(/^rbw-proxy: /);
    }
    expect(run(checkArgs("25"), JSON.stringify(configured())).status).toBe(1);
  });

  it("latency prints the override when its file exists and the default otherwise", () => {
    const config = file("race.environment", "# from the build\nRBW_RACE_LATENCY_MS=0\n");
    expect(run(["latency", config, join(dir, "missing")]).stdout).toBe("0\n");
    const override = file("race-latency.environment", "RBW_RACE_LATENCY_MS=40\n");
    expect(run(["latency", config, override]).stdout).toBe("40\n");
    expect(run(["latency", config, file("bad", "RBW_RACE_LATENCY_MS=x\n")]).status).toBe(2);
  });

  it("valid-latency accepts only an allowed latency", () => {
    expect(run(["valid-latency", "25"]).status).toBe(0);
    expect(run(["valid-latency", "10001"]).status).toBe(2);
    expect(run(["valid-latency", "default"]).status).toBe(2);
  });

  it("mark prints the offset after the mark request and exits 3 while it is not logged", () => {
    const path = file("api.log", log());
    expect(run(["mark", path, "0"])).toMatchObject({ status: 0, stdout: `${String(MARK)}\n` });
    expect(run(["mark", path, String(MARK)]).status).toBe(3);
  });

  it("audit exits 0, 1 or 3 and names the request that could have changed the proxy", () => {
    expect(run(["audit", file("clean.log", log(OWN_CHECK)), String(MARK), String(CAP)]).status).toBe(0);
    expect(run(["audit", file("waiting.log", log()), String(MARK), String(CAP)]).status).toBe(3);
    const changed = run(["audit", file("changed.log", log(request("POST", "/reset", "curl"), OWN_CHECK)), String(MARK), String(CAP)]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toBe("rbw-proxy: POST /reset from 127.0.0.1:40000 (curl) after the proxy was set\n");
  });
});
