import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../../umami/src/manifest.ts";
import { argDefaults, memo, parseDockerfile } from "../../umami/test/kit-files.ts";
import { PROXY, TOXIC, TOXIPROXY_VERSION } from "../src/race-manifest.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = memo(() => read("../Dockerfile"));
const tzDockerfile = memo(() => read("../../umami/Dockerfile"));
const instructions = memo(() => parseDockerfile(dockerfile()));
const froms = memo(() => instructions().filter((instruction) => instruction.keyword === "FROM"));
const proxyScript = memo(() => read("../bin/rbw-proxy"));
const startScript = memo(() => read("../bin/rbw-start"));
const stopScript = memo(() => read("../bin/rbw-stop"));
const selftest = memo(() => read("../bin/rbw-kit-selftest"));
const raceSelftest = memo(() => read("../bin/rbw-race-selftest"));

/** Lines of a script without comment lines, so a comment cannot satisfy a check. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

describe("overlay on the time-zone kit image", () => {
  it("builds the final stage on the tz-kit build context, not on a rebuild of kit/umami", () => {
    expect(froms().at(-1)?.args).toBe("tz-kit AS race");
    expect(dockerfile()).toMatch(/--build-context tz-kit=docker-image:\/\/<kit tag>/);
  });

  it("copies only from umami-race and bind-mounts the kit directory only for the manifest step", () => {
    const copies = instructions().filter((instruction) => instruction.keyword === "COPY" && !instruction.args.includes("--from="));
    expect(copies.length).toBeGreaterThanOrEqual(4);
    for (const copy of copies) {
      const source = copy.args.split(/\s+/).find((part) => !part.startsWith("--")) ?? "";
      expect(source, copy.args).toMatch(/^umami-race\//);
    }
    const mounts = instructions().filter((instruction) => instruction.args.includes("--mount="));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.args).toMatch(/node \/mnt\/kit\/umami-race\/src\/race-manifest\.ts/);
  });

  it("pins its one registry image to the same node:22-alpine digest as kit/umami", () => {
    const registryFroms = froms().filter((from) => from.args.startsWith("${REGISTRY}"));
    expect(registryFroms.map((from) => from.args)).toEqual(["${REGISTRY}/library/node@${NODE22_DIGEST} AS toxiproxy"]);
    expect(argDefaults(instructions()).get("NODE22_DIGEST")).toBe(argDefaults(parseDockerfile(tzDockerfile())).get("NODE22_DIGEST"));
  });

  it("is not referenced by the time-zone Dockerfile", () => {
    expect(tzDockerfile()).not.toMatch(/umami-race|toxiproxy|5433/i);
  });

  it("keeps the base start, stop and self-test scripts as -base before installing the wrappers", () => {
    expect(dockerfile()).toMatch(/for script in rbw-start rbw-stop rbw-kit-selftest; do/);
    expect(dockerfile()).toMatch(/mv "\/opt\/rbw\/bin\/\$script" "\/opt\/rbw\/bin\/\$script-base"/);
    expect(dockerfile()).toMatch(/COPY --chown=0:0 --chmod=0755 umami-race\/bin\/ \/opt\/rbw\/bin\//);
    expect(readdirSync(new URL("../bin/", import.meta.url)).sort()).toEqual([
      "rbw-kit-selftest",
      "rbw-proxy",
      "rbw-race-selftest",
      "rbw-start",
      "rbw-stop",
    ]);
  });

  it("replaces the app environment and keeps the base manifest beside the race one", () => {
    expect(dockerfile()).toMatch(/COPY --chown=0:0 --chmod=0644 umami-race\/etc\/app\.environment \/opt\/rbw\/etc\/app\.environment/);
    expect(dockerfile()).toMatch(/mv \/opt\/rbw\/verifier\/image-manifest\.json \/opt\/rbw\/verifier\/base-image-manifest\.json/);
    expect(dockerfile()).toMatch(/--out \/opt\/rbw\/verifier\/image-manifest\.json/);
    expect(dockerfile()).toMatch(/chmod 0600 \/opt\/rbw\/verifier\/image-manifest\.json/);
  });

  it("leaves no root cache from the manifest step, which the base self-test's cold check would report", () => {
    const manifestRun = instructions().find((instruction) => instruction.args.includes("race-manifest.ts"))?.args ?? "";
    expect(manifestRun).toMatch(/rm -rf \/root\/\.cache \/root\/\.local \/root\/\.npm$/);
  });
});

describe("Toxiproxy binary", () => {
  it("pins the version, downloads by the target architecture and checks the committed hash before installing", () => {
    expect(argDefaults(instructions()).get("TOXIPROXY_VERSION")).toBe(TOXIPROXY_VERSION);
    const fetch = instructions().find((instruction) => instruction.stage === "toxiproxy" && instruction.keyword === "RUN")?.args ?? "";
    const order = ["grep \"  ${name}\\$\" /rbw/toxiproxy.sha256", "wget -q -O", "sha256sum -c pinned.sha256", "install -m 0755"].map((step) =>
      fetch.indexOf(step),
    );
    expect(order.every((index) => index >= 0), fetch).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fetch).toContain('name="toxiproxy-server-linux-${TARGETARCH}"');
    expect(fetch).toContain("https://github.com/Shopify/toxiproxy/releases/download/v${TOXIPROXY_VERSION}/${name}");
    expect(fetch).toContain('= "toxiproxy-server version ${TOXIPROXY_VERSION}"');
  });

  it("ships the hash list in the root-only verifier area", () => {
    expect(dockerfile()).toMatch(/COPY --chown=0:0 --chmod=0600 umami-race\/toxiproxy\.sha256 \/opt\/rbw\/verifier\/toxiproxy\.sha256/);
  });
});

describe("latency setting", () => {
  it("defaults to 0 ms", () => {
    expect(argDefaults(instructions()).get("RACE_LATENCY_MS")).toBe("0");
  });

  it("writes only RBW_RACE_LATENCY_MS into race.environment, after checking the value", () => {
    const run = instructions().find((instruction) => instruction.args.includes("race.environment") && instruction.keyword === "RUN")?.args ?? "";
    expect(run).toMatch(/'' \| 0\?\* \| \*\[!0-9\]\*\) echo "RACE_LATENCY_MS must be a whole number of milliseconds"; exit 1/);
    expect(run).toContain('test "$RACE_LATENCY_MS" -le 10000');
    expect(run).toContain("RBW_RACE_LATENCY_MS=%s");
    expect(run.indexOf("exit 1")).toBeLessThan(run.indexOf("> /opt/rbw/etc/race.environment"));
  });

  it("is read by rbw-proxy through the shipped helper, which the manifest step's parser also uses", () => {
    const body = code(proxyScript());
    expect(body).toContain("CONFIG=/opt/rbw/etc/race.environment");
    expect(body).toContain("HELPER=/opt/rbw/verifier/rbw-proxy-check.ts");
    expect(body).toContain('helper latency "$CONFIG" "$OVERRIDE"');
    expect(read("../src/race-manifest.ts")).toContain('import { readLatencyFile } from "./proxy-check.ts";');
  });

  it("ships the helper root-only in the verifier area", () => {
    expect(dockerfile()).toMatch(/COPY --chown=0:0 --chmod=0600 umami-race\/src\/proxy-check\.ts \/opt\/rbw\/verifier\/rbw-proxy-check\.ts/);
    expect(read("../src/proxy-check.ts")).not.toMatch(/from "\.\.?\//);
  });

  it("can be set per container by root only, and every start, set and check uses the latency in effect", () => {
    const body = code(proxyScript());
    expect(body).toContain("OVERRIDE=$RUN/race-latency.environment");
    expect(body).toContain('[ "$(id -u)" = 0 ] || fail "must run as root"');
    expect(body).toMatch(/\( umask 077 && printf 'RBW_RACE_LATENCY_MS=%s\\n' "\$value" > "\$OVERRIDE\.tmp" && mv "\$OVERRIDE\.tmp" "\$OVERRIDE" \)/);
    expect(body).toContain('helper valid-latency "$value" || exit 1');
    expect(body).toMatch(/set-latency\) \[ \$# -eq 2 \] \|\| fail [^\n]*; set_latency "\$2" ;;/);
    expect(body).toMatch(/latency\) show_latency ;;/);
    for (const name of ["start", "check", "set_latency", "show_latency"]) {
      const fn = body.slice(body.indexOf(`\n${name}() {`), body.indexOf("\n}\n", body.indexOf(`\n${name}() {`)));
      expect(fn, name).toContain("latency=$(latency_ms)");
    }
    expect(body).toMatch(/if running; then\n\s*apply_toxic "\$latency" \|\| exit 1\n\s*check > \/dev\/null \|\| fail/);
  });
});

describe("rbw-proxy", () => {
  const body = memo(() => code(proxyScript()));

  it("listens only on loopback, with the API on 8474 and the proxy on 5433 in front of 5432", () => {
    expect(body()).toContain("API_HOST=127.0.0.1");
    expect(body()).toContain(`API_PORT=${PROXY.api.split(":")[1] ?? ""}`);
    expect(body()).toContain(`LISTEN=${PROXY.listen}`);
    expect(body()).toContain(`UPSTREAM=${PROXY.upstream}`);
    expect(body()).toContain(`PROXY=${PROXY.name}`);
    expect(body()).toContain(`exec "$0" -host "$1" -port "$2" -seed 1 >> "$3"`);
    expect(body()).toContain('/usr/local/bin/toxiproxy-server "$API_HOST" "$API_PORT" "$LOG"');
    expect(body()).not.toMatch(/0\.0\.0\.0|-host\s+localhost/);
  });

  it("runs toxiproxy-server as rbw-db through the launcher, never as root", () => {
    expect(body()).toMatch(/"\$LAUNCH" --as db [^\n]*\\\n[^\n]*\\\n\s*\/bin\/sh -c [^\n]*\\\n\s*\/usr\/local\/bin\/toxiproxy-server /);
    expect(body().match(/\/usr\/local\/bin\/toxiproxy-server/g)).toHaveLength(1);
  });

  it("has toxiproxy-server write its API log itself, unbuffered, where only rbw-db and root can read it", () => {
    expect(body()).toContain("API_LOG_DIR=/var/lib/rbw/toxiproxy");
    expect(body()).toContain("LOG=$API_LOG_DIR/api.log");
    expect(body()).toContain('install -d -o rbw-db -g rbw-db -m 0700 "$API_LOG_DIR"');
    expect(body()).toContain("umask 077 && exec");
  });

  it("sets one downstream latency toxic with no jitter and full toxicity", () => {
    expect(body()).toContain(`TOXIC=${TOXIC.name}`);
    expect(body()).toContain('\\"type\\":\\"latency\\",\\"stream\\":\\"downstream\\",\\"toxicity\\":1,\\"attributes\\":{\\"latency\\":$1,\\"jitter\\":0}');
  });

  it("marks the log after its own writes, then checks the state and audits every request since the mark", () => {
    const apply = body().slice(body().indexOf("\napply_toxic() {"), body().indexOf("\ncheck() {"));
    const steps = ["from=$(log_size)", "-X DELETE", "-X POST", 'api rbw-proxy-mark -o /dev/null "$API/version"', 'retry helper mark "$LOG" "$from"', '> "$MARK"'];
    const order = steps.map((step) => apply.indexOf(step));
    expect(order.every((index) => index >= 0), apply).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const check = body().slice(body().indexOf("\ncheck() {"), body().indexOf("\nshow_latency() {"));
    expect(check).toContain('api rbw-proxy-check "$API/proxies"');
    expect(check).toContain('helper check "$PROXY" "$LISTEN" "$UPSTREAM" "$TOXIC" "$latency" || ok=1');
    expect(check).toContain('retry helper audit "$LOG" "$(cat "$MARK")" "$LOG_BYTES" || ok=1');
    expect(check).toContain('[ -f "$MARK" ] || {');
    expect(body()).toMatch(/apply_toxic "\$latency" \|\| exit 1\n\s*check > \/dev\/null \|\| fail "the proxy does not match its configuration"/);
    expect(body()).toContain('rm -f "$RUN/toxiproxy.pid" "$MARK"');
  });

  it("keeps the retry loop's status apart from the check's", () => {
    const retry = body().slice(body().indexOf("\nretry() {"), body().indexOf("\napply_toxic() {"));
    expect(retry).not.toMatch(/\b(status|ok|tries)=/);
  });

  it("writes its launcher's PID where rbw-stop finds it", () => {
    expect(body()).toContain('echo $! > "$RUN/toxiproxy.pid"');
    expect(body()).toContain("RUN=/run/rbw");
  });
});

describe("start and stop", () => {
  it("starts Postgres, then the proxy, then Umami through the base script", () => {
    const body = code(startScript());
    const steps = ['"$BIN/rbw-start-base" --db-only || exit 1', '"$BIN/rbw-proxy" start || exit 1', 'exec "$BIN/rbw-start-base"'].map((step) =>
      body.indexOf(step),
    );
    expect(steps.every((index) => index >= 0), body).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(body).toMatch(/\[ "\$db_only" -eq 1 \] && exit 0/);
  });

  it("stops the base stack and then the proxy, failing if either fails", () => {
    const body = code(stopScript());
    expect(body.indexOf('"$BIN/rbw-stop-base" || status=1')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('"$BIN/rbw-proxy" stop || status=1')).toBeGreaterThan(body.indexOf('"$BIN/rbw-stop-base"'));
    expect(body).toContain('exit "$status"');
  });
});

describe("race app environment", () => {
  it("routes the app's database connection through the proxy listener", () => {
    expect(parseEnvFile(read("../etc/app.environment")).set.DATABASE_URL).toBe(
      "postgresql://umami_app:synthetic-umami-app-password@127.0.0.1:5433/umami",
    );
  });
});

describe("in-image self-test", () => {
  it("runs the base self-test and then the race checks, passing only when both pass", () => {
    const body = code(selftest());
    expect(body.indexOf('"$BIN/rbw-kit-selftest-base"')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('"$BIN/rbw-race-selftest"')).toBeGreaterThan(body.indexOf('"$BIN/rbw-kit-selftest-base"'));
    expect(body).toMatch(/if \[ "\$base" -eq 0 \] && \[ "\$race" -eq 0 \]; then/);
  });

  it("names every race check", () => {
    for (const name of [
      "toxiproxy-binary-matches-pinned-hash",
      "proxy-listens-on-loopback-only",
      "proxy-runs-as-db-user",
      "app-cannot-signal-proxy",
      "proxy-has-configured-latency-toxic",
      "app-database-url-points-at-proxy",
      "app-database-traffic-goes-through-proxy",
      "manifest-records-proxy",
      "latency-can-be-set-per-container",
      "proxy-check-detects-app-api-change",
    ]) {
      expect(code(raceSelftest())).toContain(`check ${name} `);
    }
  });

  it("checks the binary against the same version as the manifest step", () => {
    expect(raceSelftest()).toContain(`TOXIPROXY_VERSION=${TOXIPROXY_VERSION}`);
  });
});
