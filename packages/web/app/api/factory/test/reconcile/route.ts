// POST /api/factory/test/reconcile { request_id }: test mode only, no session; 404 otherwise (contract section 15.1).
import { postTestReconcile } from "../../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handle((server) => postTestReconcile(request, server));
}
