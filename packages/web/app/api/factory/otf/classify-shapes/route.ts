import { handleOtfClassifyShapes } from "../../../../../src/otf/classify-shapes.ts";

export const dynamic = "force-dynamic";
/** One provider call, abandoned after 20 seconds; no repair. */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleOtfClassifyShapes(request);
}
