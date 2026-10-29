// POST /api/factory/otf/builder/jobs/{job_id}/result: the job's outcome, with the bundles and certificate when delivered (docs/otf/SPEC.md section 3.2).
import "../../../../../../../../src/otf/compose.ts";
import { handleOtfBuilder, postResult } from "../../../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ job_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handleOtfBuilder((deps) => postResult(request, deps, params));
}
