// GET /api/factory/requests/{request_id}/cases/{case_id}/packages/{bug-case|validator}: one package
// part of a delivered case, hash-checked before it is sent (contract section 10.2).
import { getPackage } from "../../../../../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ request_id: string; case_id: string; part: string }> }): Promise<Response> {
  const params = await context.params;
  return handle((server) => getPackage(request, server, params));
}
