import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIT_IMAGE_FILE, KitImageError, loadKitImage } from "../adapter/kit.ts";
import { BUILD_PLATFORM, PACKAGE_DIR, QualifyError, REGISTRY_INSPECT_FORMAT, REPO_ROOT, buildArgsV2, main, parseRegistryReference, writeKitImagePin, writeRegistryPin } from "../adapter/qualify.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const TAG = "rbw-task-report:synthetic-build";
const IMAGE_ID = `sha256:${"a1".repeat(32)}`;
const REPOSITORY = "registry.synthetic.invalid/rbw/task-report";
const MANIFEST = `sha256:${"b2".repeat(32)}`;
const PUSHED = `${REPOSITORY}@${MANIFEST}`;
/** The image ID the classic image store gives a pulled image: its config digest, not the manifest digest. */
const CONFIG_ID = `sha256:${"c3".repeat(32)}`;

function pinFile(): string {
  return join(mkdtempSync(join(tmpdir(), "rbw-qualify-test-")), "kit-image.v2.json");
}

/** One `docker image inspect` answer in the registry pin's format. */
function inspectLine(architecture: string, repoDigests: unknown): string {
  return `${CONFIG_ID} ${architecture} ${JSON.stringify(repoDigests)}\n`;
}

/**
 * A docker CLI that writes its arguments, one per line, to `args`, succeeds for `build`, and answers
 * `image inspect` with `answer`, or as for an absent image when `answer` is null.
 */
function stubDocker(answer: string | null): { docker: string; args: string } {
  const dir = mkdtempSync(join(tmpdir(), "rbw-qualify-docker-"));
  const args = join(dir, "args");
  const answerFile = join(dir, "answer");
  if (answer !== null) writeFileSync(answerFile, answer);
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${args}'`,
      'case "$1" in',
      "  build) exit 0 ;;",
      `  image) if [ -f '${answerFile}' ]; then cat '${answerFile}'; exit 0; fi; echo 'Error: No such image' >&2 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  return { docker, args };
}

function calledWith(args: string): string[] {
  return readFileSync(args, "utf8").split("\n").slice(0, -1);
}

describe("qualify build", () => {
  it("builds the kit image for linux/amd64, the only platform the hosted copies run", async () => {
    expect(BUILD_PLATFORM).toBe("linux/amd64");
    const args = buildArgsV2(TAG, "/r");
    expect(args.slice(0, 3)).toEqual(["build", "--platform", "linux/amd64"]);
    expect(args.slice(-3)).toEqual(["-t", TAG, "/r/kit/task-report"]);
    const stub = stubDocker(null);
    await expect(main(["build", "--tag", TAG], { docker: stub.docker })).resolves.toBe(0);
    expect(calledWith(stub.args)).toEqual(buildArgsV2(TAG, REPO_ROOT));
  });

  it("refuses a tag outside rbw-task-report before asking Docker", async () => {
    const stub = stubDocker(null);
    await expect(main(["build", "--tag", "synthetic-other:latest"], { docker: stub.docker })).rejects.toThrow(new QualifyError("--tag must be rbw-task-report:<name>"));
    expect(existsSync(stub.args)).toBe(false);
  });
});

describe("qualify pin", () => {
  it("pins the built image by its reference, image ID and architecture, which prepare and evaluate then load", () => {
    const file = pinFile();
    const pin = writeKitImagePin(file, TAG, `${IMAGE_ID} amd64\n`);
    expect(pin).toEqual({ reference: TAG, digest: IMAGE_ID, architecture: "amd64" });
    expect(loadKitImage(file)).toEqual(pin);
    // pin writes the file the adapter reads by default in prepare and evaluate.
    expect(KIT_IMAGE_FILE).toBe(join(PACKAGE_DIR, "catalog/kit-image.v2.json"));
  });

  it("refuses an image it cannot identify and leaves the pin unwritten", () => {
    const file = pinFile();
    expect(() => writeKitImagePin(file, TAG, "")).toThrow(KitImageError);
    expect(() => writeKitImagePin(file, TAG, `${IMAGE_ID} s390x`)).toThrow(KitImageError);
    expect(() => writeKitImagePin(file, TAG, "sha256:short arm64")).toThrow(KitImageError);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a tag the build would refuse, before asking Docker", async () => {
    await expect(main(["pin", "--tag", "synthetic-other:latest"])).rejects.toThrow(new QualifyError("--tag must be rbw-task-report:<name>"));
  });

  it("asks for exactly one of --tag and --registry", async () => {
    const stub = stubDocker(inspectLine("amd64", [PUSHED]));
    const file = pinFile();
    await expect(main(["pin"], { docker: stub.docker, kitImageFile: file })).rejects.toThrow(new QualifyError("pin needs --tag rbw-task-report:<name> or --registry <repository>@sha256:<digest>"));
    await expect(main(["pin", "--tag", TAG, "--registry", PUSHED], { docker: stub.docker, kitImageFile: file })).rejects.toThrow(new QualifyError("pin takes --tag or --registry, not both"));
    expect(existsSync(stub.args)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

describe("qualify pin --registry", () => {
  it("pins a pushed image by its repository and manifest digest, as amd64, after Docker confirms both", async () => {
    const stub = stubDocker(inspectLine("amd64", [`registry.synthetic.invalid/rbw/other@sha256:${"d4".repeat(32)}`, PUSHED]));
    const file = pinFile();
    await expect(main(["pin", "--registry", PUSHED], { docker: stub.docker, kitImageFile: file })).resolves.toBe(0);
    expect(calledWith(stub.args)).toEqual(["image", "inspect", "--format", REGISTRY_INSPECT_FORMAT, PUSHED]);
    // The pin is the manifest digest the registry serves, never the local image ID.
    expect(loadKitImage(file)).toEqual({ reference: REPOSITORY, digest: MANIFEST, architecture: "amd64" });
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.format).toBe("rbw.task-report.kit-image.v2");
    expect(JSON.stringify(written)).not.toContain(CONFIG_ID);
  });

  it("refuses an image Docker does not have and leaves the pin unwritten", async () => {
    const stub = stubDocker(null);
    const file = pinFile();
    await expect(main(["pin", "--registry", PUSHED], { docker: stub.docker, kitImageFile: file })).rejects.toThrow(new QualifyError(`image ${PUSHED} is not available; pull it with docker pull --platform linux/amd64 ${PUSHED}`));
    expect(existsSync(file)).toBe(false);
  });

  it("refuses an image that is not amd64 or does not list the pinned repository digest", () => {
    const file = pinFile();
    const registry = parseRegistryReference(PUSHED);
    expect(() => writeRegistryPin(file, registry, inspectLine("arm64", [PUSHED]))).toThrow(new QualifyError(`image ${PUSHED} is for arm64, not amd64`));
    // The classic image store lists no repository digest for a build before its push.
    expect(() => writeRegistryPin(file, registry, inspectLine("amd64", []))).toThrow(new QualifyError(`${PUSHED} is not one of the image's repository digests`));
    expect(() => writeRegistryPin(file, registry, inspectLine("amd64", null))).toThrow(QualifyError);
    expect(() => writeRegistryPin(file, registry, inspectLine("amd64", [`${REPOSITORY}@sha256:${"d4".repeat(32)}`]))).toThrow(QualifyError);
    expect(() => writeRegistryPin(file, registry, inspectLine("amd64", [`registry.synthetic.invalid/rbw/other@${MANIFEST}`]))).toThrow(QualifyError);
    expect(() => writeRegistryPin(file, registry, "")).toThrow(new QualifyError(`Docker's answer for ${PUSHED} is not an image ID, architecture and repository digests`));
    expect(() => writeRegistryPin(file, registry, `${CONFIG_ID} amd64 [not json`)).toThrow(QualifyError);
    expect(() => writeRegistryPin(file, registry, `${CONFIG_ID} amd64 {"a":1}`)).toThrow(QualifyError);
    expect(existsSync(file)).toBe(false);
  });

  it("matches a Docker Hub repository in either of the names Docker reports", () => {
    const file = pinFile();
    const hub = parseRegistryReference(`docker.io/synthetic/task-report@${MANIFEST}`);
    expect(writeRegistryPin(file, hub, inspectLine("amd64", [`synthetic/task-report@${MANIFEST}`]))).toEqual({ reference: "docker.io/synthetic/task-report", digest: MANIFEST, architecture: "amd64" });
    const short = parseRegistryReference(`synthetic/task-report@${MANIFEST}`);
    expect(writeRegistryPin(file, short, inspectLine("amd64", [`docker.io/synthetic/task-report@${MANIFEST}`])).reference).toBe("synthetic/task-report");
  });

  it("accepts a registry repository with an optional port and a namespace", () => {
    expect(parseRegistryReference(PUSHED)).toEqual({ repository: REPOSITORY, digest: MANIFEST });
    expect(parseRegistryReference(`registry.synthetic.invalid:5000/task-report@${MANIFEST}`)).toEqual({ repository: "registry.synthetic.invalid:5000/task-report", digest: MANIFEST });
    expect(parseRegistryReference(`synthetic/task_report.kit-v2@${MANIFEST}`)).toEqual({ repository: "synthetic/task_report.kit-v2", digest: MANIFEST });
  });

  it("refuses, before asking Docker, a reference that is not <repository>@sha256:<digest>", async () => {
    const digestOnly = "--registry must be <repository>@sha256:<digest>, the pushed image's manifest digest";
    const notRegistry = "--registry must name a registry repository, <registry or namespace>/<name>, in lowercase";
    const tagged = "--registry must name the repository without a tag; the digest names the image";
    const cases: [string, string][] = [
      [REPOSITORY, digestOnly],
      [`${REPOSITORY}:kit-v2`, digestOnly],
      [`${REPOSITORY}@sha256:${"B2".repeat(32)}`, digestOnly],
      [`${REPOSITORY}@sha256:abc`, digestOnly],
      [`${REPOSITORY}@sha512:${"b2".repeat(64)}`, digestOnly],
      [`${REPOSITORY}@${MANIFEST}@${MANIFEST}`, digestOnly],
      ["", digestOnly],
      [`${REPOSITORY}:kit-v2@${MANIFEST}`, tagged],
      [`rbw-task-report@${MANIFEST}`, notRegistry],
      [`rbw-task-report:kit-v2@${MANIFEST}`, notRegistry],
      [`Registry.synthetic.invalid/rbw/task-report@${MANIFEST}`, notRegistry],
      [`registry.synthetic.invalid//task-report@${MANIFEST}`, notRegistry],
      [`registry.synthetic.invalid:port/task-report@${MANIFEST}`, notRegistry],
      [`registry.synthetic.invalid/rbw/-task-report@${MANIFEST}`, notRegistry],
      [`registry.synthetic.invalid/rbw/task-report/@${MANIFEST}`, notRegistry],
      [`registry.synthetic.invalid/${"a".repeat(256)}@${MANIFEST}`, notRegistry],
    ];
    const stub = stubDocker(inspectLine("amd64", [PUSHED]));
    for (const [value, message] of cases) {
      expect(() => parseRegistryReference(value), value).toThrow(new QualifyError(message));
      await expect(main(["pin", "--registry", value], { docker: stub.docker, kitImageFile: pinFile() }), value).rejects.toThrow(new QualifyError(message));
    }
    expect(existsSync(stub.args)).toBe(false);
  });
});

describe("qualify README", () => {
  it("the README's version 2 commands pin the image they build before prepare, and pin a pushed build by its digest", () => {
    const readme = readFileSync(join(pkg, "README.md"), "utf8");
    const steps = readme
      .split("\n")
      .filter((line) => line.startsWith("node packages/host-task-report/adapter/qualify.ts "))
      .map((line) => line.trim().split(/\s+/).slice(2));
    const local = steps.filter((step) => step[1] !== "--registry");
    expect(local.map((step) => step[0])).toEqual(["build", "pin", "prepare", "run", "evaluate"]);
    expect(local[1]).toEqual(["pin", ...(local[0] ?? []).slice(1)]);
    expect(steps.filter((step) => step[1] === "--registry")).toEqual([["pin", "--registry", "<repository>@sha256:<digest>"]]);
  });
});
