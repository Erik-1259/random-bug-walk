import { handleOtfCustomer } from "../../../../../../../../src/otf/handlers.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; part: string }> }): Promise<Response> {
  const { id, part } = await context.params;
  return handleOtfCustomer((handlers) => handlers.artifact(request, id, part));
}
