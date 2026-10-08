import { AwsClient, AwsV4Signer } from "aws4fetch";
import { HatidError } from "../../core/errors";
import type { BucketKind } from "../backend";
import { xmlText } from "./xml";

/** Decided by the live R2 verification (docs/specs/2026-10-08-r2-verification.md, V3). */
export const DEFAULT_SIGN_CONTENT_LENGTH = true;
export const COPY_OBJECT_MAX = 5 * 1024 ** 3;

export type R2ClientConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: { private: string; public?: string | undefined };
  /** Origin of the custom domain attached to the public bucket. Required when buckets.public is set. */
  publicBaseUrl?: string | undefined;
  /** Defaults to https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string | undefined;
  /** HMAC secret for multipart tokens. Defaults to a key derived from secretAccessKey. */
  tokenSecret?: string | undefined;
  /** Cache-Control applied to public copies, e.g. "public, max-age=31536000, immutable". */
  publicCacheControl?: string | undefined;
  /** Sign Content-Length into upload URLs. */
  signContentLength?: boolean | undefined;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch | undefined;
  /** @internal Lower the single CopyObject limit (tests). */
  copyObjectMax?: number | undefined;
};

export type R2Context = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  buckets: { private: string; public: string | undefined };
  publicBaseUrl: string | undefined;
  publicCacheControl: string | undefined;
  tokenSecret: string | undefined;
  signContentLength: boolean;
  copyObjectMax: number;
  aws: AwsClient;
  doFetch: typeof fetch;
};

const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HatidError("CONFIG", `createR2Client: ${name} is required`);
  return value;
}

export function createContext(c: R2ClientConfig): R2Context {
  const accountId = required(c.accountId, "accountId");
  const accessKeyId = required(c.accessKeyId, "accessKeyId");
  const secretAccessKey = required(c.secretAccessKey, "secretAccessKey");
  const priv = required(c.buckets?.private, "buckets.private");
  const pub = c.buckets.public;
  for (const b of [priv, pub]) {
    if (b !== undefined && !BUCKET_RE.test(b)) throw new HatidError("CONFIG", `createR2Client: invalid bucket name "${b}"`);
  }
  if (pub !== undefined && pub === priv) throw new HatidError("CONFIG", "createR2Client: buckets.public must differ from buckets.private");
  let publicBaseUrl: string | undefined;
  if (pub !== undefined) {
    const raw = required(c.publicBaseUrl, "publicBaseUrl (when buckets.public is set)");
    let u: URL;
    try { u = new URL(raw); } catch { throw new HatidError("CONFIG", "createR2Client: publicBaseUrl must be a URL"); }
    const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (u.protocol !== "https:" && !local) throw new HatidError("CONFIG", "createR2Client: publicBaseUrl must use https");
    publicBaseUrl = raw.replace(/\/+$/, "");
  }
  const custom = c.fetch;
  return {
    accessKeyId, secretAccessKey,
    endpoint: (c.endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, ""),
    buckets: { private: priv, public: pub },
    publicBaseUrl,
    publicCacheControl: c.publicCacheControl,
    tokenSecret: c.tokenSecret,
    signContentLength: c.signContentLength ?? DEFAULT_SIGN_CONTENT_LENGTH,
    copyObjectMax: c.copyObjectMax ?? COPY_OBJECT_MAX,
    aws: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }),
    // wrap so Workers never sees an unbound `fetch` ("Illegal invocation")
    doFetch: custom ?? ((input, init) => globalThis.fetch(input, init)),
  };
}

export function bucketName(ctx: R2Context, kind: BucketKind): string {
  if (kind === "private") return ctx.buckets.private;
  if (!ctx.buckets.public) throw new HatidError("CONFIG", "No public bucket configured (createR2Client buckets.public)");
  return ctx.buckets.public;
}

export const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

export function objectUrl(ctx: R2Context, kind: BucketKind, key: string, query = ""): string {
  return `${ctx.endpoint}/${bucketName(ctx, kind)}/${encodeKey(key)}${query}`;
}

/** Header-signed server request. Network failures become STORAGE errors. */
export async function send(ctx: R2Context, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await ctx.doFetch(await ctx.aws.sign(url, init));
  } catch (cause) {
    throw new HatidError("STORAGE", "R2 request failed", { cause });
  }
}

/** Returns the body text; throws STORAGE for unexpected statuses or 200-with-<Error> replies. */
export async function expectOk(res: Response, what: string, ok: readonly number[] = [200, 204]): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!ok.includes(res.status) || /<Error>/.test(text)) {
    const code = xmlText(text, "Code");
    throw new HatidError("STORAGE", `R2 ${what} failed (HTTP ${res.status}${code ? ` ${code}` : ""})`);
  }
  return text;
}

/** Query-signed URL (signs every header passed in). */
export async function presign(ctx: R2Context, method: "GET" | "PUT", url: string, headers: Record<string, string>, expiresInMs: number): Promise<string> {
  const u = new URL(url);
  u.searchParams.set("X-Amz-Expires", String(Math.min(604_800, Math.max(1, Math.ceil(expiresInMs / 1000)))));
  const signer = new AwsV4Signer({
    url: u.toString(), method, headers: new Headers(headers), accessKeyId: ctx.accessKeyId, secretAccessKey: ctx.secretAccessKey,
    service: "s3", region: "auto", signQuery: true, allHeaders: true,
  });
  return (await signer.sign()).url.toString();
}
