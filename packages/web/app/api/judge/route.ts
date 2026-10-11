// POST /api/judge { request_id }: starts one judge replay (design note section 6, route steps 1 to 7).
import { postJudge } from "../../../src/judge/handlers.ts";
import { judgeServer } from "../../../src/judge/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return postJudge(request, judgeServer());
}
