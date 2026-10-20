// GET /api/factory/test/evidence?request_id=: test mode only, no session; 404 otherwise (contract section 15.1).
import { getTestEvidence } from "../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle((server) => getTestEvidence(request, server));
}
