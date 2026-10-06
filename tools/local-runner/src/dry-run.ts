// The dry run: every input hash and every docker command of the full sequence, in order, built by
// the same functions the real run uses, without Docker. Values that only the image can give (its
// digest, its image manifest and the frozen original suite) are shown as placeholders.
import { join } from "node:path";
import { TRIAL_PROFILES } from "@rbw/schema";
import { APP_DIR, COPY_OUTER_LIMIT_MS, KILL_GRACE_MS, copyCommands } from "./copy.ts";
import { commandLine } from "./docker.ts";
import { inputHashes, inputLines, loadRunInputs } from "./inputs.ts";
import { JOB_KINDS, JOB_LABELS, newRunIds } from "./jobs.ts";
import { containerName } from "./plan.ts";
import { IMAGE_MANIFEST_PATH } from "./projection.ts";
import type { SequenceOptions } from "./sequence.ts";

export async function dryRun(options: SequenceOptions, deps: { uuid: () => string }): Promise<string[]> {
  const inputs = await loadRunInputs(options);
  const ids = newRunIds(deps.uuid);
  const image = `<digest of ${options.image}>`;
  const target = inputs.probes.data.target_path;
  const lines = [
    "dry run: the docker commands and input hashes of the full sequence; nothing is run",
    ...inputLines(inputHashes(inputs, { kitSha256: null, originalSuiteSha256: null })),
    "input kit_sha256 and original_suite_sha256 come from the image manifest and the freeze copy",
    `outer limit per copy ${String(COPY_OUTER_LIMIT_MS)} ms: TERM, then KILL after ${String(KILL_GRACE_MS)} ms if the container is still running`,
  ];
  const print = (args: readonly string[]): void => {
    lines.push(commandLine(args));
  };
  print(["image", "inspect", "--format", "{{.Id}}", options.image]);
  const exporter = containerName(ids.run_tag, "source", "export");
  for (const args of [["create", "--name", exporter, "--network", "none", image], ["cp", `${exporter}:${APP_DIR}`, "-"], ["cp", `${exporter}:${IMAGE_MANIFEST_PATH}`, "-"], ["rm", "--force", exporter]]) {
    print(args);
  }
  const freeze = { job: "freeze", trial_id: "freeze", state: "clean" as const, image, mode: "freeze" as const, job_dir: null, placement: null };
  for (const args of copyCommands({ ...freeze, container: containerName(ids.run_tag, "source", "freeze"), work_dir: join(options.work, "freeze") })) print(args);
  for (const label of JOB_LABELS) {
    const trials = TRIAL_PROFILES[JOB_KINDS[label]].trials.filter((trial) => label !== "alternative-fix" || trial.trial_id === "fixed-01");
    for (const trial of trials) {
      const plan = {
        job: label,
        trial_id: trial.trial_id,
        state: trial.code_state,
        container: containerName(ids.run_tag, label, trial.trial_id),
        image,
        mode: "trial" as const,
        work_dir: join(options.work, "copies", label, trial.trial_id),
        job_dir: join(options.work, "jobs", label, "job"),
        placement: trial.code_state === "clean" ? null : { path: target, bytes: Buffer.alloc(0), sha256: "" },
      };
      for (const args of copyCommands(plan)) print(args);
    }
  }
  return lines;
}
