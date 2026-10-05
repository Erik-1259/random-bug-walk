import { canonicalDigest } from "./canonical.ts";
import type { ProjectPolicy } from "./generated.ts";
import { assertRecord } from "./validate.ts";

export { policySuccessionErrors } from "./rules.ts";

export interface PolicyInput {
  projectId: string;
  outputRepository: string | null;
  publicArtifactBaseUri: string | null;
  policyVersion: number;
}

export interface BuiltPolicy {
  policy: ProjectPolicy;
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Builds a ProjectPolicy from run-time values. Both destinations set gives public_demo/public;
 * both null gives evaluation/private; anything else is refused. Throws RecordError when invalid.
 */
export function buildPolicy(input: PolicyInput): BuiltPolicy {
  const publicDemo = input.outputRepository !== null || input.publicArtifactBaseUri !== null;
  const candidate = {
    schema_version: 1,
    project_id: input.projectId,
    purpose: publicDemo ? "public_demo" : "evaluation",
    visibility: publicDemo ? "public" : "private",
    output_repository: input.outputRepository,
    public_artifact_base_uri: input.publicArtifactBaseUri,
    policy_version: input.policyVersion,
  };
  const policy = assertRecord("ProjectPolicy", candidate);
  const { bytes, sha256 } = canonicalDigest(policy);
  return { policy, bytes, sha256 };
}
