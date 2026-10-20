// POST /api/factory/requests: starts a request (contract section 7).
import { postStart } from "../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handle((server) => postStart(request, server));
}
