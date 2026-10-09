import { HatidError } from "../../core/errors";
import { decodeText, encodeText, toAmzMetaHeaders } from "../../core/metadata";
import type { CompletedPart, SignedPart } from "../../core/types";
import type { BucketKind } from "../backend";
import { bucketName, encodeKey, expectOk, objectUrl, presign, send, type R2Context } from "./context";
import { escapeXml, xmlBlocks, xmlText } from "./xml";

const uploadQuery = (uploadId: string, partNumber?: number) =>
  `?${partNumber === undefined ? "" : `partNumber=${partNumber}&`}uploadId=${encodeURIComponent(uploadId)}`;

async function initiate(ctx: R2Context, kind: BucketKind, key: string, headers: Record<string, string>): Promise<string> {
  const xml = await expectOk(await send(ctx, objectUrl(ctx, kind, key, "?uploads"), { method: "POST", headers }), "CreateMultipartUpload", [200]);
  const uploadId = xmlText(xml, "UploadId");
  if (!uploadId) throw new HatidError("STORAGE", "R2 CreateMultipartUpload returned no UploadId");
  return uploadId;
}

async function complete(ctx: R2Context, kind: BucketKind, key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
  const body = `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  await expectOk(await send(ctx, objectUrl(ctx, kind, key, uploadQuery(uploadId)), { method: "POST", body }), "CompleteMultipartUpload", [200]);
}

async function abort(ctx: R2Context, kind: BucketKind, key: string, uploadId: string): Promise<void> {
  await expectOk(await send(ctx, objectUrl(ctx, kind, key, uploadQuery(uploadId)), { method: "DELETE" }), "AbortMultipartUpload", [200, 204, 404]);
}

export async function createMultipart(ctx: R2Context, r: { key: string; contentType: string; signedMetadata: Record<string, string> }) {
  return { uploadId: await initiate(ctx, "private", r.key, { "content-type": r.contentType, ...toAmzMetaHeaders(r.signedMetadata) }) };
}

export async function signParts(ctx: R2Context, r: { key: string; uploadId: string; parts: { partNumber: number; size: number }[]; expiresIn: number }): Promise<SignedPart[]> {
  return Promise.all(r.parts.map(async (p) => ({
    partNumber: p.partNumber,
    url: await presign(ctx, "PUT", objectUrl(ctx, "private", r.key, uploadQuery(r.uploadId, p.partNumber)),
      ctx.signContentLength ? { "content-length": String(p.size) } : {}, r.expiresIn),
    headers: {},
  })));
}

export const completeMultipart = (ctx: R2Context, r: { key: string; uploadId: string; parts: CompletedPart[] }) =>
  complete(ctx, "private", r.key, r.uploadId, r.parts);

export const abortMultipart = (ctx: R2Context, r: { key: string; uploadId: string }) => abort(ctx, "private", r.key, r.uploadId);

export async function listMultipart(ctx: R2Context, r: { prefix: string; cursor?: string | undefined; limit: number }) {
  const q = new URLSearchParams({ uploads: "", prefix: r.prefix, "max-uploads": String(Math.min(1000, Math.max(1, r.limit))) });
  if (r.cursor) {
    const c = JSON.parse(decodeText(r.cursor) ?? "{}") as { k?: string; u?: string };
    if (c.k) q.set("key-marker", c.k);
    if (c.u) q.set("upload-id-marker", c.u);
  }
  const xml = await expectOk(await send(ctx, `${ctx.endpoint}/${bucketName(ctx, "private")}/?${q}`), "ListMultipartUploads", [200]);
  const uploads = xmlBlocks(xml, "Upload").map((u) => ({
    key: xmlText(u, "Key") ?? "", uploadId: xmlText(u, "UploadId") ?? "", initiated: Date.parse(xmlText(u, "Initiated") ?? "") || 0,
  }));
  if (xmlText(xml, "IsTruncated") !== "true") return { uploads };
  return { uploads, cursor: encodeText(JSON.stringify({ k: xmlText(xml, "NextKeyMarker"), u: xmlText(xml, "NextUploadIdMarker") })) };
}

/** UploadPartCopy in copyObjectMax-sized ranges, for sources above the single CopyObject limit. */
export async function multipartCopy(
  ctx: R2Context, target: BucketKind, r: { pendingKey: string; finalKey: string; size: number }, headers: Record<string, string>,
): Promise<void> {
  const uploadId = await initiate(ctx, target, r.finalKey, headers);
  try {
    const parts: CompletedPart[] = [];
    const partSize = ctx.copyObjectMax;
    for (let n = 1, start = 0; start < r.size; n++, start += partSize) {
      const end = Math.min(r.size, start + partSize) - 1;
      const res = await send(ctx, objectUrl(ctx, target, r.finalKey, uploadQuery(uploadId, n)), {
        method: "PUT",
        headers: { "x-amz-copy-source": `/${bucketName(ctx, "private")}/${encodeKey(r.pendingKey)}`, "x-amz-copy-source-range": `bytes=${start}-${end}` },
      });
      const etag = xmlText(await expectOk(res, "UploadPartCopy", [200]), "ETag");
      if (!etag) throw new HatidError("STORAGE", "R2 UploadPartCopy returned no ETag");
      parts.push({ partNumber: n, etag });
    }
    await complete(ctx, target, r.finalKey, uploadId, parts);
  } catch (error) {
    await abort(ctx, target, r.finalKey, uploadId).catch(() => {});
    throw error;
  }
}
