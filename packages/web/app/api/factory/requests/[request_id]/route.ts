// GET /api/factory/requests/{request_id}?after={seq}: the request's status (contract section 8).
import { getRequestStatus } from "../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ request_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handle((server) => getRequestStatus(request, server, params));
}
