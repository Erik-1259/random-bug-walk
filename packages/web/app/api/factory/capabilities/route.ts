// GET /api/factory/capabilities: public; hosts, bug types, criteria and limits (contract section 4).
import { getCapabilities } from "../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handle((server) => getCapabilities(request, server));
}
