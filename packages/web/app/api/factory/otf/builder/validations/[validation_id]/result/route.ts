// POST /api/factory/otf/builder/validations/{validation_id}/result: a validation's six cells (docs/otf/SPEC.md section 3.2).
import { handleOtfBuilder, postValidationResult } from "../../../../../../../../src/otf/builder-handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ validation_id: string }> }): Promise<Response> {
  const params = await context.params;
  return handleOtfBuilder((deps) => postValidationResult(request, deps, params));
}
