// POST /api/factory/otf/builder/claim: the builder's long poll for work, also its idle heartbeat (docs/otf/SPEC.md section 3.2).
import "../../../../../../src/otf/compose.ts";
import { handleOtfBuilder, postClaim } from "../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";
// The claim is held up to 20 s.
export const maxDuration = 30;

export function POST(request: Request): Promise<Response> {
  return handleOtfBuilder((deps) => postClaim(request, deps));
}
