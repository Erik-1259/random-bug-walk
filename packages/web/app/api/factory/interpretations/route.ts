// POST /api/factory/interpretations: public, free and side-effect free (contract section 6).
import { postInterpretation } from "../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../src/factory-server/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handle((server) => postInterpretation(request, server));
}
