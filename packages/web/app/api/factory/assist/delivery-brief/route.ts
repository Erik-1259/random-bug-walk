// POST /api/factory/assist/delivery-brief: the same bug designer endpoint as /api/assist/delivery-brief, under the
// factory session cookie's path (Path=/api/factory), so a signed-in browser sends the cookie here, and
// in the factory routes' traced files, so the delivery brief can read the prepared packages.
import { postDeliveryBrief } from "../../../../../src/assist/handlers.ts";
import { handleAssist } from "../../../../../src/assist/server.ts";

export const dynamic = "force-dynamic";
/** A web search and a model call, each abandoned after 20 s. */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleAssist((server, deps) => postDeliveryBrief(request, server, deps));
}
