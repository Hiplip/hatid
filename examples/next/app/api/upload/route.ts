import { createNextHandler } from "@hiplip/hatid/next";
import { getHatid } from "@/lib/hatid";

export const runtime = "nodejs";
let handler: ReturnType<typeof createNextHandler> | undefined;
export function POST(req: Request) {
  handler ??= createNextHandler(getHatid().uploads);
  return handler.POST(req);
}
