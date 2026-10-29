import "../../../../../../../src/otf/compose.ts";
import { handleOtfCustomer } from "../../../../../../../src/otf/handlers.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return handleOtfCustomer((handlers) => handlers.validate(request, id));
}
