// GET /api/factory/requests/{request_id}/cases/{case_id}/validations/{validation_id}: one validation
// run (contract section 11).
import { getValidationRun } from "../../../../../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ request_id: string; case_id: string; validation_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handle((server) => getValidationRun(request, server, params));
}
