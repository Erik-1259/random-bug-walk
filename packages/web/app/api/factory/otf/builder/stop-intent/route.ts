// POST /api/factory/otf/builder/stop-intent: the builder machine asks before it stops itself (docs/otf/SPEC.md section 4).
import "../../../../../../src/otf/compose.ts";
import { handleOtfBuilder, postStopIntent } from "../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleOtfBuilder((deps) => postStopIntent(request, deps));
}
