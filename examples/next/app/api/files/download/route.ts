import { createDownloadUrl } from "@hiplip/hatid/server";
import { getHatid } from "@/lib/hatid";
import { demoUserId } from "@/lib/session";
import { getFile } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const record = await getFile(key);
  if (!record || record.owner !== demoUserId(req)) return new Response("Not found", { status: 404 });
  if (record.url) return Response.redirect(record.url, 302);
  const url = await createDownloadUrl(getHatid().r2, { key, expiresIn: "5m", downloadName: record.fileName ?? "download" });
  return Response.redirect(url, 302);
}
