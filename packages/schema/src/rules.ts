import { canonicalDigest } from "./canonical.ts";
import type {
  ArtifactManifest,
  DefName,
  FamilyRegistry,
  ProjectPolicy,
  PublicationRecord,
  RootRun,
  RunManifest,
  StagingOmissions,
} from "./generated.ts";

/**
 * Rules JSON Schema cannot express. python/schema/src/rbw_schema/rules.py implements the same
 * rules, and the shared invalid fixtures cover each one.
 */
interface Context {
  policy?: ProjectPolicy;
  root?: RootRun;
  previous?: ProjectPolicy;
}

function strictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function registryRules(registry: FamilyRegistry): string[] {
  const errors: string[] = [];
  if (hasDuplicates(registry.families.map((family) => family.family_id))) errors.push("registry:duplicate_family");
  const fixes = registry.families.flatMap((family) => family.source_fixes.map((fix) => `${fix.upstream}\n${fix.commit}`));
  if (hasDuplicates(fixes)) errors.push("registry:duplicate_source_fix");
  if (hasDuplicates(registry.families.flatMap((family) => family.mutation_ids))) errors.push("registry:duplicate_mutation");
  return errors;
}

function runManifestRules(manifest: RunManifest, policy: ProjectPolicy | undefined): string[] {
  const errors: string[] = [];
  const root = manifest.root_execution_id;
  const [first, ...children] = manifest.executions;
  if (first?.execution_id !== root || first.parent_execution_id !== null) errors.push("manifest:root_first");
  if (children.some((child) => child.parent_execution_id !== root)) errors.push("manifest:child_parent");
  const ids = manifest.executions.map((execution) => execution.execution_id);
  if (hasDuplicates(ids)) errors.push("manifest:duplicate_execution");
  if (!strictlySorted(manifest.entries.map((entry) => entry.path))) errors.push("manifest:entries_sorted");
  for (const entry of manifest.entries) {
    if (!ids.includes(entry.execution_id)) errors.push("manifest:unknown_execution");
    if (!strictlySorted(entry.redactions.map((redaction) => redaction.category))) errors.push("manifest:redactions_sorted");
    if (entry.public_uri !== null) {
      const key = `sha256/${entry.sha256 ?? ""}`;
      const base = policy?.public_artifact_base_uri;
      if (base === undefined ? !entry.public_uri.endsWith(`/${key}`) : entry.public_uri !== `${base ?? ""}${key}`) errors.push("manifest:public_uri");
    }
  }
  // Withheld entries are numbered withheld/1 to withheld/<k> without gaps.
  const withheld = manifest.entries.filter((entry) => entry.outcome === "withheld_private").map((entry) => entry.path).sort();
  const numbered = withheld.map((_, index) => `withheld/${String(index + 1)}`).sort();
  if (withheld.some((path, index) => path !== numbered[index])) errors.push("manifest:withheld_numbering");
  return errors;
}

function omissionsRules(omissions: StagingOmissions): string[] {
  const errors: string[] = [];
  const paths = omissions.entries.flatMap((entry) => ("path" in entry ? [entry.path] : []));
  if (hasDuplicates(paths)) errors.push("omissions:duplicate_path");
  if (hasDuplicates(omissions.redactions.map((item) => `${item.path}\n${item.category}`))) errors.push("omissions:duplicate_redaction");
  return errors;
}

/** Succession of frozen policies: same project, a higher version, and public exposure never reversed. */
export function policySuccessionErrors(previous: ProjectPolicy, next: ProjectPolicy): string[] {
  const errors: string[] = [];
  if (next.project_id !== previous.project_id) errors.push("policy:other_project");
  if (canonicalDigest(next).sha256 === canonicalDigest(previous).sha256) return errors;
  if (next.policy_version <= previous.policy_version) errors.push("policy:version_not_increased");
  if (previous.visibility === "public" && next.visibility !== "public") errors.push("policy:exposure_reversed");
  return errors;
}

function contextRules(value: Record<string, unknown>, context: Context): string[] {
  const errors: string[] = [];
  if (context.policy !== undefined) {
    if ("project_id" in value && value.project_id !== context.policy.project_id) errors.push("inherit:project_id");
    if (value.project_policy_sha256 !== canonicalDigest(context.policy).sha256) errors.push("inherit:project_policy_sha256");
  }
  if (context.root !== undefined) {
    for (const key of ["project_id", "project_policy_sha256", "root_execution_id"] as const) {
      if (key in value && value[key] !== context.root[key]) errors.push(`inherit:${key}`);
    }
  }
  if (context.previous !== undefined) errors.push(...policySuccessionErrors(context.previous, value as unknown as ProjectPolicy));
  return errors;
}

/** Applies the code rules to a value that already passed the schema. */
export function checkRules(type: DefName, value: unknown, context: Context): string[] {
  const errors: string[] = [];
  switch (type) {
    case "FamilyRegistry":
      errors.push(...registryRules(value as FamilyRegistry));
      break;
    case "RootRun": {
      const root = value as RootRun;
      if (root.child_execution_ids.includes(root.root_execution_id)) errors.push("root:child_is_root");
      break;
    }
    case "ArtifactManifest":
      if (hasDuplicates((value as ArtifactManifest).entries.map((entry) => entry.key))) errors.push("artifacts:duplicate_key");
      break;
    case "PublicationRecord": {
      const record = value as PublicationRecord;
      if (record.execution_id !== record.root_execution_id) errors.push("publication:execution_not_root");
      if (!strictlySorted(record.artifacts.map((artifact) => artifact.path))) errors.push("publication:artifacts_sorted");
      break;
    }
    case "RunManifest":
      errors.push(...runManifestRules(value as RunManifest, context.policy));
      break;
    case "StagingOmissions":
      errors.push(...omissionsRules(value as StagingOmissions));
      break;
    default:
      break;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    errors.push(...contextRules(value as Record<string, unknown>, context));
  }
  return errors;
}
