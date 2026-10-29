import { handleOtfCustomer } from "../../../../../src/otf/handlers.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleOtfCustomer((handlers) => handlers.create(request));
}
