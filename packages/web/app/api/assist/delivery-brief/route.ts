// POST /api/assist/delivery-brief: the bug designer (src/assist/handlers.ts); needs the factory session.
import { postDeliveryBrief } from "../../../../src/assist/handlers.ts";
import { handleAssist } from "../../../../src/assist/server.ts";

export const dynamic = "force-dynamic";
/** A web search and a model call, each abandoned after 20 s. */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleAssist((server, deps) => postDeliveryBrief(request, server, deps));
}
