import "../../../../../../src/otf/compose.ts";
import { handleOtfTestReset } from "../../../../../../src/otf/handlers.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Test mode only: answers 404 outside RBW_FACTORY_TEST_MODE=1 on a local server. */
export function POST(request: Request): Promise<Response> {
  return handleOtfTestReset(request);
}
