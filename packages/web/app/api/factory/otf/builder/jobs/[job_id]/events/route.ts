// POST /api/factory/otf/builder/jobs/{job_id}/events: lane events and the heartbeat, answered with the stop control (docs/otf/SPEC.md section 3.2).
import "../../../../../../../../src/otf/compose.ts";
import { handleOtfBuilder, postEvents } from "../../../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ job_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handleOtfBuilder((deps) => postEvents(request, deps, params));
}
