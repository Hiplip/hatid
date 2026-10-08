import { HatidError } from "../../core/errors";
import type { CompletedPart, SignedPart } from "../../core/types";
import { parseDuration } from "../../core/units";
import type { StorageBackend } from "../backend";
import { rejected, runConfirm, type ConfirmResult, type OnConfirmed } from "./confirm";

export type MultipartToken = { key: string; uploadId: string; owner: string; route: string; size: number; partSize: number; input: unknown; exp: number };

export async function readMultipartToken(backend: StorageBackend, token: unknown, key: unknown, uploadId: unknown, route: string): Promise<MultipartToken> {
  if (typeof token !== "string" || typeof key !== "string" || typeof uploadId !== "string") throw rejected();
  const p = await backend.verifyToken({ token });
  if (!p || p.key !== key || p.uploadId !== uploadId || p.route !== route || typeof p.owner !== "string" ||
      typeof p.exp !== "number" || p.exp < Date.now() || typeof p.size !== "number" || typeof p.partSize !== "number") {
    throw rejected();
  }
  return p as unknown as MultipartToken;
}

const partCountOf = (t: MultipartToken) => Math.ceil(t.size / t.partSize);

export async function signUploadParts(backend: StorageBackend, o: {
  key: string; uploadId: string; token: string; owner: string; partNumbers: number[];
  route?: string | undefined; expiresIn?: number | string | undefined;
}): Promise<SignedPart[]> {
  const t = await readMultipartToken(backend, o.token, o.key, o.uploadId, o.route ?? "");
  if (t.owner !== o.owner) throw rejected();
  const count = partCountOf(t);
  if (!Array.isArray(o.partNumbers) || o.partNumbers.length === 0 || o.partNumbers.length > 100) {
    throw new HatidError("INVALID_INPUT", "partNumbers must contain 1–100 entries");
  }
  const unique = [...new Set(o.partNumbers)];
  for (const n of unique) {
    if (!Number.isInteger(n) || n < 1 || n > count) throw new HatidError("INVALID_INPUT", `partNumber ${String(n)} is out of range 1–${count}`);
  }
  const lastSize = t.size - t.partSize * (count - 1);
  return backend.signParts({
    key: t.key, uploadId: t.uploadId, expiresIn: parseDuration(o.expiresIn ?? "10m", "expiresIn"),
    parts: unique.map((n) => ({ partNumber: n, size: n < count ? t.partSize : lastSize })),
  });
}

export async function completeUpload(backend: StorageBackend, o: {
  key: string; uploadId: string; token: string; owner: string; parts: CompletedPart[];
  fileName?: string | undefined; route?: string | undefined; prefix?: string | undefined;
  allowedTypes?: readonly string[] | undefined; onConfirmed?: OnConfirmed | undefined;
}): Promise<ConfirmResult> {
  const route = o.route ?? "";
  const t = await readMultipartToken(backend, o.token, o.key, o.uploadId, route);
  if (t.owner !== o.owner) throw rejected();
  const count = partCountOf(t);
  const parts: unknown[] = Array.isArray(o.parts) ? o.parts : [];
  const wellFormed = parts.every((p): p is CompletedPart =>
    typeof p === "object" && p !== null && Number.isInteger((p as CompletedPart).partNumber) &&
    typeof (p as CompletedPart).etag === "string" && (p as CompletedPart).etag.length > 0 && (p as CompletedPart).etag.length <= 128);
  const numbers = wellFormed ? (parts as CompletedPart[]).map((p) => p.partNumber).sort((a, b) => a - b) : [];
  if (!wellFormed || parts.length !== count || !numbers.every((n, i) => n === i + 1)) {
    throw new HatidError("INVALID_INPUT", `parts must list each of the ${count} parts exactly once with its ETag`);
  }
  await backend.completeMultipart({ key: t.key, uploadId: t.uploadId, parts: (parts as CompletedPart[]).map((p) => ({ partNumber: p.partNumber, etag: p.etag })) });
  return runConfirm(backend, { key: t.key, fileName: o.fileName }, {
    route, prefix: o.prefix, allowedTypes: o.allowedTypes, onConfirmed: o.onConfirmed, resolveOwner: async () => o.owner,
  });
}

export async function abortUpload(backend: StorageBackend, o: { key: string; uploadId: string; token: string; owner: string; route?: string | undefined }): Promise<void> {
  const t = await readMultipartToken(backend, o.token, o.key, o.uploadId, o.route ?? "");
  if (t.owner !== o.owner) throw rejected();
  await backend.abortMultipart({ key: t.key, uploadId: t.uploadId });
}
