// GET /api/factory/example: public; the completed example, or 404 while none is published (contract section 14).
import { getExample } from "../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle((server) => getExample(request, server));
}
