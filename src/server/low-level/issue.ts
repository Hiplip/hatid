import { HatidError } from "../../core/errors";
import { slugForKey } from "../../core/filename";
import { generatePendingKey, validatePrefix } from "../../core/keys";
import { encodeSignedMeta, validateOwner } from "../../core/metadata";
import { extensionFor, isAllowedType, normalizeContentType, validateAllowedTypes } from "../../core/mime";
import type { IssueResult, Visibility } from "../../core/types";
import { parseDuration, parseSize } from "../../core/units";
import type { StorageBackend } from "../backend";

export const SINGLE_PUT_MAX = 5 * 1024 ** 3;
const MiB = 1024 ** 2;
const MIN_PART = 5 * MiB;
const MAX_PARTS = 10_000;

export type MultipartOptions = { threshold?: number | string; partSize?: number | string; tokenTtl?: number | string };
export type ResolvedMultipart = { threshold: number; partSize: number; tokenTtl: number };

export function resolveMultipart(o: MultipartOptions | false | undefined): ResolvedMultipart | null {
  if (o === false) return null;
  const threshold = parseSize(o?.threshold ?? "100MB", "multipart.threshold");
  const partSize = parseSize(o?.partSize ?? "10MB", "multipart.partSize");
  const tokenTtl = parseDuration(o?.tokenTtl ?? "24h", "multipart.tokenTtl");
  if (threshold >= SINGLE_PUT_MAX) throw new HatidError("CONFIG", "multipart.threshold must be below 5 GiB");
  if (partSize < MIN_PART || partSize > SINGLE_PUT_MAX) throw new HatidError("CONFIG", "multipart.partSize must be between 5 MiB and 5 GiB");
  return { threshold, partSize, tokenTtl };
}

export function planParts(size: number, preferred: number): { partSize: number; partCount: number } {
  const minForCount = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  const partSize = Math.max(preferred, minForCount, MIN_PART);
  return { partSize, partCount: Math.ceil(size / partSize) };
}

export type CreateUploadUrlOptions = {
  owner: string;
  visibility: Visibility;
  prefix: string;
  contentType: string;
  size: number;
  maxSize: number | string;
  allowedTypes: readonly string[];
  expiresIn?: number | string | undefined;
  /** Route name recorded in signed metadata ("" for low-level use). */
  route?: string | undefined;
  /** Identifiers only: stored as plaintext object metadata. */
  input?: unknown;
  metadata?: unknown;
  datePrefix?: boolean | undefined;
  keyExtension?: boolean | undefined;
  keyFileName?: boolean | undefined;
  /** Only used when keyFileName is true. */
  fileName?: string | undefined;
  multipart?: MultipartOptions | false | undefined;
};

export async function createUploadUrl(backend: StorageBackend, o: CreateUploadUrlOptions): Promise<IssueResult> {
  const owner = validateOwner(o.owner);
  if (o.visibility !== "public" && o.visibility !== "private") throw new HatidError("CONFIG", 'visibility must be "public" or "private"');
  if (o.visibility === "public" && !backend.capabilities.publicBucket) {
    throw new HatidError("CONFIG", 'visibility "public" requires buckets.public and publicBaseUrl in createR2Client');
  }
  const prefix = validatePrefix(o.prefix);
  const maxSize = parseSize(o.maxSize, "maxSize");
  const allowed = validateAllowedTypes(o.allowedTypes);
  const expiresIn = parseDuration(o.expiresIn ?? "10m", "expiresIn");
  const mp = resolveMultipart(o.multipart);

  if (typeof o.size !== "number" || !Number.isFinite(o.size)) throw new HatidError("INVALID_INPUT", "size must be a number of bytes");
  if (o.size <= 0) throw new HatidError("FILE_TOO_LARGE", "Empty files are not allowed");
  if (!Number.isSafeInteger(o.size)) throw new HatidError("INVALID_INPUT", "size must be an integer number of bytes");
  if (o.size > maxSize) throw new HatidError("FILE_TOO_LARGE", `File is ${o.size} bytes; the limit is ${maxSize}`);
  const type = normalizeContentType(o.contentType);
  if (!type || !isAllowedType(type, allowed)) throw new HatidError("INVALID_TYPE", `Content type "${String(o.contentType)}" is not allowed`);
  const useMultipart = mp !== null && o.size > mp.threshold;
  if (!useMultipart && o.size > SINGLE_PUT_MAX) throw new HatidError("FILE_TOO_LARGE", "File exceeds the 5 GiB single-upload limit");

  const key = generatePendingKey({
    prefix,
    datePrefix: o.datePrefix ?? true,
    extension: o.keyExtension ? extensionFor(type) : undefined,
    nameSlug: o.keyFileName && o.fileName !== undefined ? slugForKey(o.fileName) : undefined,
  });
  const route = o.route ?? "";
  const signedMetadata = encodeSignedMeta({
    route, owner, visibility: o.visibility, size: o.size, maxSize, type, issuedAt: Date.now(), input: o.input, metadata: o.metadata,
  });

  if (!useMultipart) {
    const s = await backend.issueUpload({ key, contentType: type, size: o.size, signedMetadata, expiresIn });
    return { kind: "single", key, url: s.url, method: "PUT", headers: s.headers };
  }
  const plan = planParts(o.size, mp.partSize);
  const { uploadId } = await backend.createMultipart({ key, contentType: type, signedMetadata });
  const token = await backend.signToken({
    // `input` is dropped by JSON when undefined, so routes without input see `undefined` again
    payload: { key, uploadId, owner, route, size: o.size, partSize: plan.partSize, input: o.input, exp: Date.now() + mp.tokenTtl },
  });
  return { kind: "multipart", key, uploadId, partSize: plan.partSize, partCount: plan.partCount, token };
}
