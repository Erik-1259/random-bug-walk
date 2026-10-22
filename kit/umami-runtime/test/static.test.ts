import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBuildOutputs } from "../../umami/src/manifest.ts";
import { memo, parseDockerfile } from "../../umami/test/kit-files.ts";
import type { Instruction } from "../../umami/test/kit-files.ts";

const path = (relative: string): URL => new URL(relative, import.meta.url);
const read = (relative: string): string => readFileSync(path(relative), "utf8");
const dockerfile = memo(() => read("../Dockerfile"));
const instructions = memo(() => parseDockerfile(dockerfile()));
const kitInstructions = memo(() => parseDockerfile(read("../../umami/Dockerfile")));
const prepare = memo(() => read("../bin/rbw-prepare-app"));
const selftest = memo(() => read("../bin/rbw-runtime-selftest"));

function ofKeyword(list: Instruction[], keyword: string): Instruction[] {
  return list.filter((instruction) => instruction.keyword === keyword);
}

/** A COPY's flags and its positional arguments (sources, then the destination). */
function copyParts(instruction: Instruction): { flags: string[]; paths: string[] } {
  const parts = instruction.args.split(/\s+/).filter((part) => part !== "");
  return { flags: parts.filter((part) => part.startsWith("--")), paths: parts.filter((part) => !part.startsWith("--")) };
}

/** Lines of a script without comment lines, so a comment cannot satisfy a check. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** The body of one `kind)` branch of a shell case statement, up to its `;;`. */
function caseBranch(text: string, kind: string): string {
  const start = text.indexOf(`    ${kind})`);
  expect(start, kind).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf(";;", start));
}

describe("the stages", () => {
  it("copies from the finished kit image given as the umami-kit build context into a scratch stage", () => {
    expect(ofKeyword(instructions(), "FROM").map((from) => from.args)).toEqual(["umami-kit AS kit", "scratch AS runtime"]);
    expect(dockerfile()).toContain("docker build --build-context umami-kit=docker-image://<kit image> -t <tag> kit/umami-runtime");
  });

  it("runs no program: there is no RUN, no ADD and no mount, so nothing is removed from a lower layer", () => {
    const keywords = new Set(instructions().map((instruction) => instruction.keyword));
    expect([...keywords].sort()).toEqual(["CMD", "COPY", "ENTRYPOINT", "ENV", "FROM", "WORKDIR"]);
    expect(dockerfile()).not.toMatch(/--mount=/);
  });
});

describe("what the image copies from the kit", () => {
  const fromKit = memo(() => ofKeyword(instructions(), "COPY").filter((copy) => copy.args.includes("--from=kit")));

  it("copies the kit's root without its app tree, its fixture package, its app file hash list and the kernel file systems", () => {
    const [root] = fromKit();
    if (root === undefined) throw new Error("no COPY from the kit");
    const { flags, paths } = copyParts(root);
    expect(paths).toEqual(["/", "/"]);
    expect(flags.filter((flag) => flag.startsWith("--exclude=")).map((flag) => flag.slice("--exclude=".length)).sort()).toEqual(
      ["dev", "opt/rbw/verifier/app-tracked.sha256", "opt/rbw/verifier/kit/umami-fixture", "proc", "sys", "workspace/app"].sort(),
    );
    expect(flags.filter((flag) => !flag.startsWith("--exclude="))).toEqual(["--from=kit"]);
  });

  it("leaves out exactly the paths where the kit image puts the app source, the fixture and the hash list", () => {
    const kitCopies = ofKeyword(kitInstructions(), "COPY").map(copyParts);
    const destination = (source: string): string | undefined => kitCopies.find((copy) => copy.paths[0] === source)?.paths.at(-1);
    expect(destination("/src")).toBe("/workspace/app");
    expect(destination("/rbw-app-tracked.sha256")).toBe("/opt/rbw/verifier/app-tracked.sha256");
    // The driver and the fixture packages arrive through the rbw-kit context; the fixture's slot is umami-fixture/.
    expect(kitCopies.find((copy) => copy.flags.includes("--from=rbw-kit"))?.paths).toEqual(["/", "/opt/rbw/verifier/kit/"]);
    expect(read("../../../packages/umami-driver/src/kit.ts")).toContain('fixture: join(verifierDir, "kit", "umami-fixture")');
  });

  it("copies back only Umami's locked dependencies, each to the path the kit installed it at", () => {
    const rest = fromKit().slice(1).map(copyParts);
    for (const copy of rest) {
      expect(copy.flags).toEqual(["--from=kit"]);
      expect(copy.paths[0]).toBe(copy.paths[1]);
      expect(copy.paths[0]).toMatch(/^\/workspace\/app\/(packages\/[a-z-]+\/)?node_modules$/);
    }
    const installed = ofKeyword(kitInstructions(), "COPY")
      .map(copyParts)
      .filter((copy) => copy.flags.includes("--from=deps"))
      .map((copy) => copy.paths.at(-1));
    expect(rest.map((copy) => copy.paths[1])).toEqual(installed);
    expect(installed.length).toBeGreaterThanOrEqual(3);
  });

  it("adds only its own scripts from the build context, root-owned and executable", () => {
    const own = ofKeyword(instructions(), "COPY").filter((copy) => !copy.args.includes("--from="));
    expect(own.map((copy) => copy.args)).toEqual(["--chown=0:0 --chmod=0755 bin/ /opt/rbw/bin/"]);
    for (const script of ["rbw-prepare-app", "rbw-runtime-selftest"]) {
      expect(statSync(path(`../bin/${script}`)).mode & 0o111, script).not.toBe(0);
      expect(read(`../bin/${script}`).startsWith("#!/bin/sh\n"), script).toBe(true);
    }
  });

  it("keeps the kit's working directory and entry point, and runs the runtime self-test by default", () => {
    const last = (list: Instruction[], keyword: string): string | undefined => ofKeyword(list, keyword).at(-1)?.args;
    expect(last(instructions(), "WORKDIR")).toBe(last(kitInstructions(), "WORKDIR"));
    expect(last(instructions(), "ENTRYPOINT")).toBe(last(kitInstructions(), "ENTRYPOINT"));
    expect(last(instructions(), "CMD")).toBe('["/opt/rbw/bin/rbw-runtime-selftest"]');
    expect(last(instructions(), "ENV")).toMatch(/^PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin /);
  });
});

describe("rbw-prepare-app", () => {
  it("reads the build outputs where the kit image installs the list, and handles every kind the list uses", () => {
    const install = ofKeyword(kitInstructions(), "COPY").map(copyParts).find((copy) => copy.paths[0] === "build-outputs.txt");
    expect(install?.paths[1]).toBe("/opt/rbw/etc/build-outputs.txt");
    expect(code(prepare())).toContain("OUTPUTS=/opt/rbw/etc/build-outputs.txt");
    const kinds = new Set(parseBuildOutputs(read("../../umami/build-outputs.txt")).map((output) => output.kind));
    expect([...kinds].sort()).toEqual(["dir", "file", "sticky", "tracked"]);
    for (const kind of kinds) caseBranch(prepare(), kind);
  });

  it("gives each kind of build output the owner and mode the kit image gives it", () => {
    const kitLoop = kitInstructions().find((instruction) => instruction.keyword === "RUN" && instruction.args.includes("build-outputs.txt"))?.args ?? "";
    expect(kitLoop).toContain('dir) test ! -e "$path"; install -d -o rbw-app -g rbw-app -m 0755 "$path"');
    expect(kitLoop).toContain('file) test ! -e "$path"; : > "$path"; chown rbw-app:rbw-app "$path"; chmod 0644 "$path"');
    expect(kitLoop).toContain('sticky) test -d "$path"; chown root:rbw-app "$path"; chmod 1775 "$path"');
    expect(kitLoop).toContain('tracked) test -f "$path"; chown rbw-app:rbw-app "$path"');
    expect(caseBranch(prepare(), "dir")).toMatch(/chown rbw-app:rbw-app "\$target"\n\s+chmod 0755 "\$target"/);
    expect(caseBranch(prepare(), "file")).toMatch(/chown rbw-app:rbw-app "\$target"\n\s+chmod 0644 "\$target"/);
    expect(caseBranch(prepare(), "sticky")).toMatch(/chown root:rbw-app "\$target"\n\s+chmod 1775 "\$target"/);
    expect(caseBranch(prepare(), "tracked")).toMatch(/chown rbw-app:rbw-app "\$target"/);
  });

  it("makes the rest of the tree root-owned and read-only to rbw-app as the kit does, outside node_modules", () => {
    const kitModes = kitInstructions().find((instruction) => instruction.keyword === "RUN" && instruction.args.includes("chmod -R u=rwX,go=rX /workspace"));
    expect(kitModes).toBeDefined();
    const body = code(prepare());
    expect(body).toContain('find "$APP" \\( -path "$APP/node_modules" -o -path "$APP/packages/*/node_modules" \\) -prune -o "$@"');
    expect(body).toContain("in_tree -exec chown root:root {} +");
    expect(body).toContain("in_tree -exec chmod u=rwX,go=rX {} +");
    // A link is refused before anything is changed, so chown and chmod never follow one out of the tree.
    expect(body.indexOf("in_tree -type l -print")).toBeLessThan(body.indexOf("in_tree -exec chown"));
  });

  it("adds src/proxy.ts from docker/proxy.ts as the kit's source stage does", () => {
    const kitProxy = kitInstructions().find((instruction) => instruction.keyword === "RUN" && instruction.args.includes("src/proxy.ts"));
    expect(kitProxy?.args).toBe("test ! -e src/proxy.ts && cp docker/proxy.ts src/proxy.ts");
    expect(code(prepare())).toContain('[ -e "$APP/src/proxy.ts" ] || install -o root -g root -m 0644 "$APP/docker/proxy.ts" "$APP/src/proxy.ts"');
  });

  it("stops at the first failure and refuses to run as another user than root", () => {
    expect(code(prepare())).toMatch(/^set -eu$/m);
    expect(code(prepare())).toContain('[ "$(id -u)" = 0 ] || { echo "rbw-prepare-app: must run as root" >&2; exit 2; }');
  });
});

describe("rbw-runtime-selftest", () => {
  it("runs each of its checks", () => {
    const body = code(selftest());
    const defined = [...body.matchAll(/^([a-z_]+)\(\) \{$/gm)].map((match) => match[1] ?? "");
    const run = [...body.matchAll(/^check ([a-z-]+) ([a-z_]+)$/gm)].map((match): [string, string] => [match[1] ?? "", match[2] ?? ""]);
    const helpers = ["cleanup", "check", "outside_dependencies"];
    expect(run.map(([, fn]) => fn).sort()).toEqual(defined.filter((name) => !helpers.includes(name)).sort());
    for (const [name, fn] of run) expect(name.replaceAll("-", "_")).toBe(fn);
  });

  it("checks for each path the image leaves out", () => {
    const body = code(selftest());
    expect(body).toContain('[ ! -e "$VERIFIER/kit/umami-fixture" ]');
    expect(body).toContain('[ ! -e "$VERIFIER/app-tracked.sha256" ]');
    expect(body).toContain("check no-app-source-files no_app_source_files");
    expect(body).toContain("check no-app-source-directories no_app_source_directories");
  });

  it("freezes the original suite with the driver and prints the kit manifest's hash", () => {
    const body = code(selftest());
    expect(body).toContain('"$NODE" "$DRIVER" freeze --out "$scratch/original-suite.json"');
    expect(body).toContain('kit_manifest_sha256=$(sha256sum "$VERIFIER/image-manifest.json"');
  });
});
