import type { CompletedPart, SignedPart, Visibility } from "../core/types";

export type BucketKind = "private" | "public";
export type ObjectInfo = { size: number; contentType: string; etag: string; lastModified: number };
export type InspectResult =
  | { state: "pending"; size: number; contentType: string; metadata: Record<string, string> }
  | { state: "confirmed"; metadata: Record<string, string> }
  | { state: "missing" };

/**
 * Storage operations used by hatid's server orchestration.
 * Every method takes and returns plain JSON-serializable data so a future HTTP backend can implement it.
 * Durations are milliseconds.
 *
 * @experimental Unstable until v1.0. Use `createR2Client` rather than implementing this yourself.
 */
export interface StorageBackend {
  readonly capabilities: { publicBucket: boolean; publicBaseUrl?: string };
  issueUpload(req: { key: string; contentType: string; size: number; signedMetadata: Record<string, string>; expiresIn: number }): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }>;
  inspect(req: { key: string }): Promise<InspectResult>;
  promote(req: { pendingKey: string; finalKey: string; visibility: Visibility; contentType: string; size: number; metadata: Record<string, string> }): Promise<void>;
  writeReceipt(req: { finalKey: string; metadata: Record<string, string> }): Promise<void>;
  deleteObject(req: { key: string; bucket: BucketKind }): Promise<void>;
  deleteObjects(req: { keys: string[]; bucket: BucketKind }): Promise<{ deleted: number }>;
  head(req: { key: string; bucket: BucketKind }): Promise<ObjectInfo | null>;
  createDownloadUrl(req: { key: string; expiresIn: number; contentDisposition?: string | undefined }): Promise<string>;
  createMultipart(req: { key: string; contentType: string; signedMetadata: Record<string, string> }): Promise<{ uploadId: string }>;
  signParts(req: { key: string; uploadId: string; parts: { partNumber: number; size: number }[]; expiresIn: number }): Promise<SignedPart[]>;
  completeMultipart(req: { key: string; uploadId: string; parts: CompletedPart[] }): Promise<void>;
  abortMultipart(req: { key: string; uploadId: string }): Promise<void>;
  list(req: { bucket: BucketKind; prefix: string; cursor?: string | undefined; limit: number }): Promise<{ objects: { key: string; lastModified: number }[]; cursor?: string }>;
  listMultipart(req: { prefix: string; cursor?: string | undefined; limit: number }): Promise<{ uploads: { key: string; uploadId: string; initiated: number }[]; cursor?: string }>;
  signToken(req: { payload: Record<string, unknown> }): Promise<string>;
  verifyToken(req: { token: string }): Promise<Record<string, unknown> | null>;
}
