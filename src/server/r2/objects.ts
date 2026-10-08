import { HatidError } from "../../core/errors";
import { finalKeyOf, receiptKeyOf } from "../../core/keys";
import { fromAmzMetaHeaders, toAmzMetaHeaders } from "../../core/metadata";
import type { BucketKind, InspectResult, ObjectInfo, StorageBackend } from "../backend";
import { bucketName, encodeKey, expectOk, objectUrl, presign, send, type R2Context } from "./context";
import { multipartCopy } from "./multipart";
import { xmlBlocks, xmlText } from "./xml";

type Req<M extends keyof StorageBackend> = StorageBackend[M] extends (r: infer R) => unknown ? R : never;

export async function issueUpload(ctx: R2Context, r: Req<"issueUpload">) {
  const headers: Record<string, string> = { "content-type": r.contentType, ...toAmzMetaHeaders(r.signedMetadata) };
  const toSign = ctx.signContentLength ? { ...headers, "content-length": String(r.size) } : headers;
  const url = await presign(ctx, "PUT", objectUrl(ctx, "private", r.key), toSign, r.expiresIn);
  return { url, method: "PUT" as const, headers };
}

async function headRaw(ctx: R2Context, kind: BucketKind, key: string): Promise<(ObjectInfo & { metadata: Record<string, string> }) | null> {
  const res = await send(ctx, objectUrl(ctx, kind, key), { method: "HEAD" });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new HatidError("STORAGE", `R2 HeadObject failed (HTTP ${res.status})`);
  return {
    size: Number(res.headers.get("content-length") ?? "0"),
    contentType: res.headers.get("content-type") ?? "",
    etag: res.headers.get("etag") ?? "",
    lastModified: Date.parse(res.headers.get("last-modified") ?? "") || 0,
    metadata: fromAmzMetaHeaders(res.headers),
  };
}

export async function head(ctx: R2Context, r: Req<"head">): Promise<ObjectInfo | null> {
  const info = await headRaw(ctx, r.bucket, r.key);
  if (!info) return null;
  const { metadata: _metadata, ...rest } = info;
  return rest;
}

export async function inspect(ctx: R2Context, r: Req<"inspect">): Promise<InspectResult> {
  // The receipt wins: it proves a run committed, even if its pending object still lingers (crash before delete).
  const receipt = await headRaw(ctx, "private", receiptKeyOf(finalKeyOf(r.key)));
  if (receipt) return { state: "confirmed", metadata: receipt.metadata };
  const pending = await headRaw(ctx, "private", r.key);
  if (pending) return { state: "pending", size: pending.size, contentType: pending.contentType, metadata: pending.metadata };
  return { state: "missing" };
}

export async function promote(ctx: R2Context, r: Req<"promote">): Promise<void> {
  const target: BucketKind = r.visibility === "public" ? "public" : "private";
  const replace = r.visibility === "public";
  const publicHeaders: Record<string, string> = {
    "content-type": r.contentType,
    ...(ctx.publicCacheControl ? { "cache-control": ctx.publicCacheControl } : {}),
  };
  if (r.size > ctx.copyObjectMax) {
    // multipart copies never carry source metadata, so pass it explicitly for private files
    return multipartCopy(ctx, target, r, replace ? publicHeaders : { "content-type": r.contentType, ...toAmzMetaHeaders(r.metadata) });
  }
  const res = await send(ctx, objectUrl(ctx, target, r.finalKey), {
    method: "PUT",
    headers: {
      ...(replace ? publicHeaders : {}),
      "x-amz-copy-source": `/${bucketName(ctx, "private")}/${encodeKey(r.pendingKey)}`,
      "x-amz-metadata-directive": replace ? "REPLACE" : "COPY",
    },
  });
  await expectOk(res, "CopyObject", [200]);
}

export async function deleteObject(ctx: R2Context, r: Req<"deleteObject">): Promise<void> {
  await expectOk(await send(ctx, objectUrl(ctx, r.bucket, r.key), { method: "DELETE" }), "DeleteObject", [200, 204, 404]);
}

/** v1 issues single DELETEs. R2 accepts batch DeleteObjects without Content-MD5 (verification V7); a later version may switch. */
export async function deleteObjects(ctx: R2Context, r: Req<"deleteObjects">): Promise<{ deleted: number }> {
  for (const key of r.keys) await deleteObject(ctx, { key, bucket: r.bucket });
  return { deleted: r.keys.length };
}

export async function writeReceipt(ctx: R2Context, r: Req<"writeReceipt">): Promise<void> {
  const res = await send(ctx, objectUrl(ctx, "private", receiptKeyOf(r.finalKey)), {
    method: "PUT", headers: { "content-type": "application/x-hatid-receipt", ...toAmzMetaHeaders(r.metadata) }, body: "",
  });
  await expectOk(res, "PutObject (receipt)", [200]);
}

export async function createDownloadUrl(ctx: R2Context, r: Req<"createDownloadUrl">): Promise<string> {
  const query = r.contentDisposition ? `?response-content-disposition=${encodeURIComponent(r.contentDisposition)}` : "";
  return presign(ctx, "GET", objectUrl(ctx, "private", r.key, query), {}, r.expiresIn);
}

export async function list(ctx: R2Context, r: Req<"list">) {
  const q = new URLSearchParams({ "list-type": "2", prefix: r.prefix, "max-keys": String(Math.min(1000, Math.max(1, r.limit))) });
  if (r.cursor) q.set("continuation-token", r.cursor);
  const xml = await expectOk(await send(ctx, `${ctx.endpoint}/${bucketName(ctx, r.bucket)}/?${q}`), "ListObjectsV2", [200]);
  const objects = xmlBlocks(xml, "Contents").map((c) => ({ key: xmlText(c, "Key") ?? "", lastModified: Date.parse(xmlText(c, "LastModified") ?? "") || 0 }));
  const next = xmlText(xml, "IsTruncated") === "true" ? xmlText(xml, "NextContinuationToken") : undefined;
  return next ? { objects, cursor: next } : { objects };
}
