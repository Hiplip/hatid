import type { StorageBackend } from "../backend";
import { createContext, type R2ClientConfig } from "./context";
import * as multipart from "./multipart";
import * as objects from "./objects";
import { createTokenSigner } from "./token";

export type { R2ClientConfig } from "./context";
export { DEFAULT_SIGN_CONTENT_LENGTH } from "./context";

export function createR2Client(config: R2ClientConfig): StorageBackend {
  const ctx = createContext(config);
  const tokens = createTokenSigner(ctx);
  return {
    capabilities: ctx.buckets.public !== undefined && ctx.publicBaseUrl !== undefined
      ? { publicBucket: true, publicBaseUrl: ctx.publicBaseUrl }
      : { publicBucket: false },
    issueUpload: (r) => objects.issueUpload(ctx, r),
    inspect: (r) => objects.inspect(ctx, r),
    promote: (r) => objects.promote(ctx, r),
    writeReceipt: (r) => objects.writeReceipt(ctx, r),
    deleteObject: (r) => objects.deleteObject(ctx, r),
    deleteObjects: (r) => objects.deleteObjects(ctx, r),
    head: (r) => objects.head(ctx, r),
    createDownloadUrl: (r) => objects.createDownloadUrl(ctx, r),
    createMultipart: (r) => multipart.createMultipart(ctx, r),
    signParts: (r) => multipart.signParts(ctx, r),
    completeMultipart: (r) => multipart.completeMultipart(ctx, r),
    abortMultipart: (r) => multipart.abortMultipart(ctx, r),
    list: (r) => objects.list(ctx, r),
    listMultipart: (r) => multipart.listMultipart(ctx, r),
    signToken: (r) => tokens.sign(r.payload),
    verifyToken: (r) => tokens.verify(r.token),
  };
}
