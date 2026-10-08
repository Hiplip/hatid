import { demoUserId } from "@/lib/session";
import { listFiles } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const owner = demoUserId(req);
  if (!owner) return Response.json([], { status: 401 });
  return Response.json(await listFiles(owner));
}
