import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY_COMMAND, COPY_DESTINATIONS } from "../../../packages/host-task-report/adapter/kit.ts";
import { buildArgsV2 } from "../../../packages/host-task-report/adapter/qualify.ts";
import { APP_DIR, ETC_DIR, EVALUATOR_DIR, EVALUATOR_SUITE_DIR, LAUNCH, RESULTS_DIR } from "../../../packages/host-task-report/src/copy/layout.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${kit}/${path}`, "utf8");
const v1 = read("Dockerfile");
const v2 = read("v2/Dockerfile");
const entry = read("v2/bin/rbw-copy-v2");

/** The files of `etc/` (relative paths), which version 2 copies into /opt/rbw/etc. */
function etcFiles(dir = "etc"): string[] {
  return readdirSync(`${kit}/${dir}`, { withFileTypes: true }).flatMap((item) => (item.isDirectory() ? etcFiles(`${dir}/${item.name}`) : [`${dir}/${item.name}`]));
}

function argDefault(text: string, name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(text)?.[1];
}

describe("kit image version 2", () => {
  it("uses version 1's base digests and dependency install", () => {
    for (const name of ["NODE24_DIGEST", "POSTGRES15_DIGEST"]) expect(argDefault(v2, name), name).toBe(argDefault(v1, name));
    expect(v2).toContain("COPY --from=app --chown=node:node package.json package-lock.json ./");
    expect(v2).toContain("RUN npm ci --ignore-scripts --no-audit --no-fund");
    expect(v2).toContain(`/home/node/deps/node_modules ${APP_DIR}/node_modules`);
    expect(v2).toContain(`/home/node/deps/node_modules ${EVALUATOR_DIR}/node_modules`);
    expect(v2).toContain(`COPY --from=app --chown=0:0 test ${EVALUATOR_SUITE_DIR}/test`);
    expect(v2).toContain(`COPY --from=launcher --chown=0:0 --chmod=0755 rbw-launch ${LAUNCH}`);
  });

  it("holds no check: nothing comes from the evaluator package, and the evaluator directory only marks ES modules", () => {
    expect(v2).not.toMatch(/--from=evaluator/);
    expect(buildArgsV2("rbw-task-report:t", "/r").join(" ")).not.toContain("evaluator=");
    expect(buildArgsV2("rbw-task-report:t", "/r")).toEqual(expect.arrayContaining(["-f", "/r/kit/task-report/v2/Dockerfile", "app=/r/hosts/task-report/app", "launcher=/r/kit/umami/bin", "/r/kit/task-report"]));
    expect(v2).toContain(`install -d -o root -g root -m 0700 ${COPY_DESTINATIONS.evaluator}`);
    expect(v2).toContain(`"type": "module"`);
  });

  it("holds no check in /opt/rbw/etc either: the setup files lose their comments and are root-only", () => {
    expect(v2).toContain(`COPY --chown=0:0 etc/ ${ETC_DIR}/`);
    for (const step of [
      `find ${ETC_DIR} -type f -name '*.sql' -exec sed -i '/^[[:space:]]*--/d' {} +`,
      `find ${ETC_DIR} -type f ! -name '*.sql' -exec sed -i '/^[[:space:]]*#/d' {} +`,
      `chown -R root:root ${ETC_DIR}`,
      `find ${ETC_DIR} -type d -exec chmod 0700 {} +`,
      `find ${ETC_DIR} -type f -exec chmod 0600 {} +`,
    ]) {
      expect(v2, step).toContain(step);
    }
    expect(v2).not.toMatch(/chmod 0?7?55[^\n]*\/opt\/rbw\/etc|chmod 0?644/);
    const files = etcFiles();
    expect(files.length).toBeGreaterThan(0);
    const kept = files
      .map((file) => {
        const comment = file.endsWith(".sql") ? /^\s*--/ : /^\s*#/;
        return read(file)
          .split("\n")
          .filter((line) => !comment.test(line))
          .join("\n");
      })
      .join("\n")
      .toLowerCase();
    for (const word of ["lock", "for update", "for share", "monitor", "evaluator", "pool", "verification", "check"]) expect(kept, word).not.toContain(word);
  });

  it("keeps the evaluator tree and the results root-only, as version 1 does", () => {
    expect(v2).toContain(`chown -R root:root ${EVALUATOR_DIR}`);
    expect(v2).toContain(`find ${EVALUATOR_DIR} -type d -exec chmod 0700 {} +`);
    expect(v2).toContain(`install -d -o root -g root -m 0700 ${RESULTS_DIR}`);
  });

  it("the copy plan's destinations and command are the image's layout", () => {
    expect(COPY_DESTINATIONS).toEqual({ app: APP_DIR, evaluator: `${EVALUATOR_DIR}/pkg`, results: `${RESULTS_DIR}/copy` });
    expect(v2).toContain(`COPY --chown=0:0 --chmod=0755 v2/bin/rbw-copy-v2 ${COPY_COMMAND}`);
    expect(v2).toContain(`CMD ["${COPY_COMMAND}"]`);
    expect(v2).toContain('ENTRYPOINT ["/sbin/tini", "--"]');
  });

  it("the entry script makes the placed check package root-only before it starts the version 2 driver", () => {
    expect(statSync(`${kit}/v2/bin/rbw-copy-v2`).mode & 0o111).not.toBe(0);
    const lines = entry.split("\n");
    const exec = lines.findIndex((line) => line.startsWith("exec "));
    expect(lines[exec]).toBe(`exec /usr/local/bin/node "$pkg/v2/copy.ts" "$@"`);
    for (const step of ['chown -R root:root "$pkg"', 'chmod 0700 "$evaluator" "$pkg"', 'find "$pkg" -type d -exec chmod 0700 {} +', 'find "$pkg" -type f -exec chmod 0600 {} +']) {
      const at = lines.indexOf(step);
      expect(at, step).toBeGreaterThan(-1);
      expect(at).toBeLessThan(exec);
    }
    expect(entry).toContain(`evaluator=${EVALUATOR_DIR}`);
  });
});
