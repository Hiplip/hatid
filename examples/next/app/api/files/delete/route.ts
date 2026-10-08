import { deleteFile } from "@hiplip/hatid/server";
import { getHatid } from "@/lib/hatid";
import { demoUserId } from "@/lib/session";
import { getFile, removeFile } from "@/lib/store";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const { key } = (await req.json()) as { key?: string };
  const record = key ? await getFile(key) : null;
  if (!record || record.owner !== demoUserId(req)) return new Response("Not found", { status: 404 });
  await deleteFile(getHatid().r2, { key: record.key, visibility: record.visibility });
  await removeFile(record.key);
  return new Response(null, { status: 204 });
}
