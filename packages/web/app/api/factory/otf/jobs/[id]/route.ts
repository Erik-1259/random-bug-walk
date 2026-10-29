import { handleOtfCustomer } from "../../../../../../src/otf/handlers.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return handleOtfCustomer((handlers) => handlers.status(request, id));
}
