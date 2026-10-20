// POST /api/factory/requests/{request_id}/cases/{case_id}/validations { validation_id }: starts a
// validation run of a delivered case (contract section 11).
import { postValidation } from "../../../../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ request_id: string; case_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handle((server) => postValidation(request, server, params));
}
