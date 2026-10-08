import { contentDisposition } from "../../core/content-disposition";
import { HatidError } from "../../core/errors";
import { assertFinalKey } from "../../core/keys";
import type { Visibility } from "../../core/types";
import { parseDuration } from "../../core/units";
import type { ObjectInfo, StorageBackend } from "../backend";

/** Signed GET for a confirmed private file. Check ownership in your DB before calling. */
export async function createDownloadUrl(backend: StorageBackend, o: {
  key: string; expiresIn?: number | string | undefined; downloadName?: string | undefined; inline?: boolean | undefined;
}): Promise<string> {
  assertFinalKey(o.key);
  const expiresIn = parseDuration(o.expiresIn ?? "5m", "expiresIn");
  const disposition = o.downloadName !== undefined ? contentDisposition(o.downloadName, o.inline ?? false) : o.inline ? "inline" : undefined;
  return backend.createDownloadUrl({ key: o.key, expiresIn, contentDisposition: disposition });
}

export function publicUrl(backend: StorageBackend, key: string): string {
  assertFinalKey(key);
  const base = backend.capabilities.publicBaseUrl;
  if (!backend.capabilities.publicBucket || !base) throw new HatidError("CONFIG", "publicUrl requires buckets.public and publicBaseUrl");
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function bucketFor(backend: StorageBackend, visibility: Visibility) {
  if (visibility === "public" && !backend.capabilities.publicBucket) throw new HatidError("CONFIG", "No public bucket configured");
  return visibility;
}

/** No authorization: check ownership in your DB first. */
export async function headFile(backend: StorageBackend, o: { key: string; visibility: Visibility }): Promise<ObjectInfo | null> {
  assertFinalKey(o.key);
  return backend.head({ key: o.key, bucket: bucketFor(backend, o.visibility) });
}

/** No authorization: check ownership in your DB first. */
export async function deleteFile(backend: StorageBackend, o: { key: string; visibility: Visibility }): Promise<void> {
  assertFinalKey(o.key);
  await backend.deleteObject({ key: o.key, bucket: bucketFor(backend, o.visibility) });
}
