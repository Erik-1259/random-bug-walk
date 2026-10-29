import { handleOtfClassify } from "../../../../../src/otf/classify.ts";

export const dynamic = "force-dynamic";
/** One model call and at most one repair, each abandoned after 20 seconds. */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleOtfClassify(request);
}
