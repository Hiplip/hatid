import { AwsV4Signer } from "aws4fetch";

export type FakeObject = {
  body: Uint8Array; contentType: string; meta: Record<string, string>;
  lastModified: number; etag: string; cacheControl: string | undefined;
};
type FakeUpload = {
  bucket: string; key: string; contentType: string; meta: Record<string, string>; cacheControl: string | undefined;
  parts: Map<number, { body: Uint8Array; etag: string }>; initiated: number;
};
export type FakeR2Options = {
  accountId?: string; accessKeyId?: string; secretAccessKey?: string; buckets?: string[];
  enforceContentLength?: boolean; rejectUnsignedAmzHeaders?: boolean; crossBucketCopy?: boolean; maxCopySize?: number;
};

const MiB = 1024 * 1024;
const enc = new TextEncoder();

function xmlError(status: number, code: string, message = code): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } });
}
const xmlOk = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status: 200, headers: { "content-type": "application/xml" } });
const stripQuotes = (e: string) => e.replace(/&quot;/g, '"').replace(/^"|"$/g, "");

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return enc.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("FakeR2: unsupported body type");
}

function metaFrom(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => { if (k.startsWith("x-amz-meta-")) out[k.slice(11)] = v; });
  return out;
}

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)\b|image\/svg\+xml\b)/i;

export class FakeR2 {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly uploads = new Map<string, FakeUpload>();
  readonly log: { method: string; path: string; query: string }[] = [];
  readonly opts: Required<Pick<FakeR2Options, "enforceContentLength" | "rejectUnsignedAmzHeaders" | "crossBucketCopy" | "maxCopySize">>;
  /** Make the next N requests fail with HTTP 500. */
  failNext = 0;
  private seq = 0;

  constructor(o: FakeR2Options = {}) {
    this.accountId = o.accountId ?? "acct";
    this.accessKeyId = o.accessKeyId ?? "AKIDTEST";
    this.secretAccessKey = o.secretAccessKey ?? "secret-test-key";
    for (const b of o.buckets ?? ["priv-bucket", "pub-bucket"]) this.buckets.set(b, new Map());
    this.opts = {
      enforceContentLength: o.enforceContentLength ?? true,
      rejectUnsignedAmzHeaders: o.rejectUnsignedAmzHeaders ?? true,
      crossBucketCopy: o.crossBucketCopy ?? true,
      maxCopySize: o.maxCopySize ?? 5 * 1024 ** 3,
    };
  }

  get endpoint(): string { return `https://${this.accountId}.r2.cloudflarestorage.com`; }
  creds() { return { accountId: this.accountId, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }; }
  object(bucket: string, key: string): FakeObject | undefined { return this.buckets.get(bucket)?.get(key); }
  keys(bucket: string): string[] { return [...(this.buckets.get(bucket)?.keys() ?? [])].sort(); }
  putObject(bucket: string, key: string, init: Partial<FakeObject> = {}): FakeObject {
    const obj: FakeObject = {
      body: init.body ?? new Uint8Array(0), contentType: init.contentType ?? "application/octet-stream",
      meta: init.meta ?? {}, lastModified: init.lastModified ?? Date.now(), etag: init.etag ?? this.nextEtag(),
      cacheControl: init.cacheControl,
    };
    this.buckets.get(bucket)!.set(key, obj);
    return obj;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : input instanceof URL ? input.href : String(input));
    const headers = new Headers(init?.headers ?? req?.headers);
    const raw = init?.body ?? (req && method !== "GET" && method !== "HEAD" ? await req.arrayBuffer() : undefined);
    return this.handle(method, url, headers, await toBytes(raw));
  };

  private nextEtag(): string { return `"${(++this.seq).toString(16).padStart(32, "0")}"`; }

  private async handle(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response> {
    if (url.host !== `${this.accountId}.r2.cloudflarestorage.com`) return xmlError(400, "InvalidHost");
    this.log.push({ method, path: url.pathname, query: url.search });
    if (this.failNext > 0) { this.failNext--; return xmlError(500, "InternalError"); }
    const denied = url.searchParams.has("X-Amz-Signature") ? await this.verifyPresigned(method, url, headers, body) : await this.verifyHeaderAuth(method, url, headers, body);
    if (denied) return denied;

    const [, bucketName = "", ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    const bucket = this.buckets.get(bucketName);
    if (!bucket) return xmlError(404, "NoSuchBucket");
    const q = url.searchParams;

    if (method === "PUT" && q.has("partNumber") && q.has("uploadId")) {
      return headers.has("x-amz-copy-source") ? this.uploadPartCopy(bucketName, key, q, headers) : this.uploadPart(bucketName, key, q, body);
    }
    if (method === "PUT" && headers.has("x-amz-copy-source")) return this.copyObject(bucketName, key, headers);
    if (method === "PUT") {
      const etag = this.nextEtag();
      bucket.set(key, { body, contentType: headers.get("content-type") ?? "application/octet-stream", meta: metaFrom(headers),
        lastModified: Date.now(), etag, cacheControl: headers.get("cache-control") ?? undefined });
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (method === "POST" && q.has("uploads")) {
      const uploadId = `upload-${++this.seq}`;
      this.uploads.set(uploadId, { bucket: bucketName, key, contentType: headers.get("content-type") ?? "application/octet-stream",
        meta: metaFrom(headers), cacheControl: headers.get("cache-control") ?? undefined, parts: new Map(), initiated: Date.now() });
      return xmlOk(`<InitiateMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === "POST" && q.has("uploadId")) return this.completeUpload(bucketName, key, q.get("uploadId")!, new TextDecoder().decode(body));
    if (method === "DELETE" && q.has("uploadId")) { this.uploads.delete(q.get("uploadId")!); return new Response(null, { status: 204 }); }
    if (method === "GET" && q.get("list-type") === "2") return this.listObjects(bucket, q);
    if (method === "GET" && q.has("uploads")) return this.listUploads(bucketName, q);
    if (method === "HEAD" || method === "GET") {
      const obj = bucket.get(key);
      if (!obj) return method === "HEAD" ? new Response(null, { status: 404 }) : xmlError(404, "NoSuchKey");
      const h = new Headers({ "content-type": obj.contentType, etag: obj.etag, "last-modified": new Date(obj.lastModified).toUTCString() });
      // Real R2 (Cloudflare edge) gzips compressible types unless the request says identity, and then sends no
      // Content-Length. Simplification: GET still returns the raw body; only the headers matter to our code.
      if (COMPRESSIBLE.test(obj.contentType) && headers.get("accept-encoding")?.trim().toLowerCase() !== "identity") {
        h.set("content-encoding", "gzip");
      } else {
        h.set("content-length", String(obj.body.byteLength));
      }
      for (const [k, v] of Object.entries(obj.meta)) h.set(`x-amz-meta-${k}`, v);
      if (obj.cacheControl) h.set("cache-control", obj.cacheControl);
      const cd = q.get("response-content-disposition");
      if (cd) h.set("content-disposition", cd);
      return new Response(method === "HEAD" ? null : (obj.body as Uint8Array<ArrayBuffer>), { status: 200, headers: h });
    }
    if (method === "DELETE") { bucket.delete(key); return new Response(null, { status: 204 }); }
    return xmlError(400, "UnsupportedOperation");
  }

  /** Re-signs a header-authenticated request with aws4fetch and compares signatures, then checks the payload hash. */
  private async verifyHeaderAuth(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response | null> {
    const m = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/s3\/aws4_request, ?SignedHeaders=([^,\s]+), ?Signature=([0-9a-f]{64})$/.exec(headers.get("authorization") ?? "");
    if (!m) return xmlError(403, "AccessDenied", headers.has("authorization") ? "Malformed Authorization header" : "AccessDenied");
    const accessKey = m[1]!;
    const signedList = m[4]!;
    const signature = m[5]!;
    if (accessKey !== this.accessKeyId) return xmlError(403, "AccessDenied", "Unknown access key");
    const amzDate = headers.get("x-amz-date") ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return xmlError(403, "AccessDenied", "Missing x-amz-date");
    const payloadHash = headers.get("x-amz-content-sha256");
    if (payloadHash === null) return xmlError(403, "AccessDenied", "Missing x-amz-content-sha256");

    const toSign = new Headers({ "x-amz-content-sha256": payloadHash });
    for (const name of signedList.split(";").filter(Boolean)) {
      if (name === "host") continue;
      const value = headers.get(name);
      if (value === null) return xmlError(403, "AccessDenied", `Missing signed header ${name}`);
      toSign.set(name, value);
    }
    const signer = new AwsV4Signer({
      url: url.toString(), method, headers: toSign, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      service: "s3", region: "auto", datetime: amzDate, allHeaders: true,
    });
    const expected = /Signature=([0-9a-f]+)$/.exec((await signer.sign()).headers.get("authorization") ?? "")?.[1];
    if (expected !== signature) return xmlError(403, "SignatureDoesNotMatch");

    if (payloadHash !== "UNSIGNED-PAYLOAD") {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      if (payloadHash !== hex) return xmlError(403, "XAmzContentSHA256Mismatch");
    }
    return null;
  }

  private async verifyPresigned(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response | null> {
    const q = url.searchParams;
    if (!(q.get("X-Amz-Credential") ?? "").startsWith(`${this.accessKeyId}/`)) return xmlError(403, "AccessDenied");
    const date = q.get("X-Amz-Date") ?? "";
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m) return xmlError(403, "AccessDenied");
    const signedAt = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    if (Date.now() > signedAt + Number(q.get("X-Amz-Expires") ?? "0") * 1000) return xmlError(403, "AccessDenied", "Request has expired");
    const signedHeaders = (q.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
    if (this.opts.rejectUnsignedAmzHeaders) {
      for (const [name] of headers) {
        if (name.startsWith("x-amz-") && !signedHeaders.includes(name)) return xmlError(403, "AccessDenied", `Unsigned header ${name}`);
      }
    }
    const toSign = new Headers();
    for (const name of signedHeaders) {
      if (name === "host") continue;
      if (name === "content-length") {
        toSign.set(name, this.opts.enforceContentLength ? String(body.byteLength) : headers.get(name) ?? String(body.byteLength));
        continue;
      }
      const value = headers.get(name);
      if (value === null) return xmlError(403, "AccessDenied", `Missing signed header ${name}`);
      toSign.set(name, value);
    }
    const unsigned = new URL(url.href);
    for (const p of ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-SignedHeaders", "X-Amz-Signature"]) unsigned.searchParams.delete(p);
    const signer = new AwsV4Signer({
      url: unsigned.toString(), method, headers: toSign, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      service: "s3", region: "auto", signQuery: true, allHeaders: true, datetime: date,
    });
    const expected = (await signer.sign()).url.searchParams.get("X-Amz-Signature");
    return expected === q.get("X-Amz-Signature") ? null : xmlError(403, "SignatureDoesNotMatch");
  }

  private source(headers: Headers): { bucket: string; key: string } | null {
    const raw = (headers.get("x-amz-copy-source") ?? "").replace(/^\//, "");
    const slash = raw.indexOf("/");
    if (slash <= 0) return null;
    return { bucket: raw.slice(0, slash), key: raw.slice(slash + 1).split("/").map(decodeURIComponent).join("/") };
  }

  private copyObject(destBucket: string, destKey: string, headers: Headers): Response {
    const src = this.source(headers);
    if (!src) return xmlError(400, "InvalidArgument");
    if (src.bucket !== destBucket && !this.opts.crossBucketCopy) return xmlError(400, "InvalidRequest", "Cross-bucket copy disabled");
    const obj = this.object(src.bucket, src.key);
    if (!obj) return xmlError(404, "NoSuchKey");
    if (obj.body.byteLength > this.opts.maxCopySize) return xmlError(400, "InvalidRequest", "Copy source too large");
    const replace = (headers.get("x-amz-metadata-directive") ?? "COPY").toUpperCase() === "REPLACE";
    const etag = this.nextEtag();
    this.buckets.get(destBucket)!.set(destKey, {
      body: obj.body, etag, lastModified: Date.now(),
      contentType: replace ? headers.get("content-type") ?? "application/octet-stream" : obj.contentType,
      meta: replace ? metaFrom(headers) : { ...obj.meta },
      cacheControl: replace ? headers.get("cache-control") ?? undefined : obj.cacheControl,
    });
    return xmlOk(`<CopyObjectResult><ETag>${etag}</ETag></CopyObjectResult>`);
  }

  private uploadOf(bucket: string, key: string, q: URLSearchParams): FakeUpload | null {
    const up = this.uploads.get(q.get("uploadId") ?? "");
    return up && up.bucket === bucket && up.key === key ? up : null;
  }

  private uploadPart(bucket: string, key: string, q: URLSearchParams, body: Uint8Array): Response {
    const up = this.uploadOf(bucket, key, q);
    if (!up) return xmlError(404, "NoSuchUpload");
    const etag = this.nextEtag();
    up.parts.set(Number(q.get("partNumber")), { body, etag });
    return new Response(null, { status: 200, headers: { etag } });
  }

  private uploadPartCopy(bucket: string, key: string, q: URLSearchParams, headers: Headers): Response {
    const up = this.uploadOf(bucket, key, q);
    const src = this.source(headers);
    const obj = src ? this.object(src.bucket, src.key) : undefined;
    if (!up || !obj) return xmlError(404, "NoSuchUpload");
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("x-amz-copy-source-range") ?? "");
    const body = range ? obj.body.slice(Number(range[1]), Number(range[2]) + 1) : obj.body;
    const etag = this.nextEtag();
    up.parts.set(Number(q.get("partNumber")), { body, etag });
    return xmlOk(`<CopyPartResult><ETag>${etag}</ETag></CopyPartResult>`);
  }

  private completeUpload(bucket: string, key: string, uploadId: string, xml: string): Response {
    const up = this.uploads.get(uploadId);
    if (!up || up.bucket !== bucket || up.key !== key) return xmlError(404, "NoSuchUpload");
    const listed = [...xml.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g)].map((m) => ({ n: Number(m[1]), etag: m[2]! }));
    if (listed.length === 0) return xmlError(400, "MalformedXML");
    const chunks: Uint8Array[] = [];
    for (const [i, p] of listed.entries()) {
      const part = up.parts.get(p.n);
      if (!part || stripQuotes(part.etag) !== stripQuotes(p.etag)) return xmlError(400, "InvalidPart");
      if (i < listed.length - 1 && part.body.byteLength < 5 * MiB) return xmlError(400, "EntityTooSmall");
      chunks.push(part.body);
    }
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    const etag = this.nextEtag();
    this.buckets.get(bucket)!.set(key, { body: out, contentType: up.contentType, meta: up.meta, lastModified: Date.now(), etag, cacheControl: up.cacheControl });
    this.uploads.delete(uploadId);
    return xmlOk(`<CompleteMultipartUploadResult><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
  }

  private listObjects(bucket: Map<string, FakeObject>, q: URLSearchParams): Response {
    const prefix = q.get("prefix") ?? "";
    const max = Number(q.get("max-keys") ?? "1000");
    const start = Number(q.get("continuation-token") ?? "0");
    const all = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
    const page = all.slice(start, start + max);
    const truncated = start + max < all.length;
    const contents = page.map((k) => `<Contents><Key>${k}</Key><LastModified>${new Date(bucket.get(k)!.lastModified).toISOString()}</LastModified><Size>${bucket.get(k)!.body.byteLength}</Size></Contents>`).join("");
    return xmlOk(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""}</ListBucketResult>`);
  }

  private listUploads(bucket: string, q: URLSearchParams): Response {
    const prefix = q.get("prefix") ?? "";
    const rows = [...this.uploads.entries()].filter(([, u]) => u.bucket === bucket && u.key.startsWith(prefix))
      .map(([id, u]) => `<Upload><Key>${u.key}</Key><UploadId>${id}</UploadId><Initiated>${new Date(u.initiated).toISOString()}</Initiated></Upload>`).join("");
    return xmlOk(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${rows}</ListMultipartUploadsResult>`);
  }
}
