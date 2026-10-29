// GET /api/factory/otf/builder/jobs/{job_id}/artifacts/{part}: a delivered bundle's bytes, for validate jobs (docs/otf/SPEC.md section 3.2).
import "../../../../../../../../../src/otf/compose.ts";
import { getBuilderArtifact, handleOtfBuilder } from "../../../../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ job_id: string; part: string }> }): Promise<Response> {
  const params = await context.params;
  return handleOtfBuilder((deps) => getBuilderArtifact(request, deps, params));
}
