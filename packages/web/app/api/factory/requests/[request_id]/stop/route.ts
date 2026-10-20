// POST /api/factory/requests/{request_id}/stop with {}: stops the request; idempotent (contract section 9).
import { postStop } from "../../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ request_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handle((server) => postStop(request, server, params));
}
