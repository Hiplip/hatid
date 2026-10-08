# hatid v1 — Design Spec

- **Package:** `@hiplip/hatid` (subpaths `/server`, `/react`, `/next`, `/trpc`)
- **Date:** 2026-10-08
- **Status:** Draft for review. Sections 1–2 were agreed in chat. Sections 3–5 (client, adapters, tooling) were written after the chat and **need review**; they are marked ⚠️.

## 0. Intent

### What it is
A lightweight, self-hosted library for direct-to-R2 uploads. Each app signs its own pre-signed URLs and the browser uploads straight to Cloudflare R2. It is a library, not a service: no dashboard, API keys, billing or multi-tenancy. It is built for Philip's apps first (future Cloudflare Workers apps; Nimbus on Next.js/Vercel; the saas-starter template) and published publicly on npm.

### Why R2
10 GB free per account, $0.015/GB-month after that, and free egress. Vercel Blob's free tier is 1 GB and 2k uploads/month, and uploads are blocked beyond it. UploadThing's free tier is 2 GB.

### Hosted service later
The package may later become the SDK for a hosted service, the way UploadThing ships an npm package that talks to its servers. All storage access therefore sits behind a `StorageBackend` interface (§2.2). Today's backend is local R2 signing. A future HTTP backend must be swappable without changing the React hook, the adapters or the app-facing route API.

### Success criteria
1. `@hiplip/hatid` is published to npm from GitHub Actions with trusted publishing (OIDC, no OTP).
2. The same server code runs on Cloudflare Workers and on Node 20+/Vercel.
3. Every safety rule in §2.10 is covered by unit tests (mocked R2 with real signature checking). The backend contract suite also passes against the real `hatid-sandbox` buckets.
4. `examples/next` demonstrates: upload with progress, confirm, list, download, delete, and an oversize file being rejected.
5. The README covers bucket setup, the API token, the CORS JSON, the custom domain, and usage on Next.js/Vercel and on Workers.

### Out of scope for v1
Dashboard, API keys, accounts, billing, image transforms, the hosted service, resumable uploads across page reloads, and server-enforced batch limits.

---

## 1. Architecture

```
src/
  core/      pure functions, no I/O: keys, size/duration parsing, MIME wildcards,
             metadata encoding, file-name cleanup, Content-Disposition, HatidError
  server/    → @hiplip/hatid/server
    backend.ts     StorageBackend interface (@experimental); JSON-only inputs and outputs
    r2/            createR2Client: aws4fetch signing, S3 calls, minimal XML reader
    low-level.ts   createUploadUrl, confirmUpload, createDownloadUrl, publicUrl,
                   headFile, deleteFile, multipart helpers, cleanupUnconfirmed
    routes.ts      defineUploads: input → auth → rateLimit → backend → onConfirmed
    protocol.ts    handleUploadAction(uploads, ctx, body): the one JSON protocol
    fetch.ts       createFetchHandler(uploads, opts) → (req: Request) => Promise<Response>
  react/     → /react   useUpload, <Dropzone/>, httpTransport, XHR + multipart uploader
  next/      → /next    createNextHandler(uploads) → { POST }
  trpc/      → /trpc    createUploadRouter(...), trpcTransport(...)
```

- **Runtime:** uses only `fetch`, WebCrypto (`crypto.subtle`) and `crypto.randomUUID`. There are no Node built-ins in `core/` or `server/`. Targets are Cloudflare Workers and Node ≥ 20.
- **Dependencies:**
  - runtime: `aws4fetch`
  - types only: `@standard-schema/spec`
  - optional peers: `react >=18`, `next >=14` (App Router), `@trpc/server >=11`, `@trpc/client >=11`
  - never `@aws-sdk/*`
- **Packaging:** ESM only. tsup builds each subpath entry plus its `.d.ts`. `package.json` gets `"type": "module"`, an `exports` map, `sideEffects: false` and `publishConfig.access: "public"` (currently missing from the placeholder; it must be added). The `/react` build output carries a `"use client"` banner.
- **Endpoint:** defaults to `https://<accountId>.r2.cloudflarestorage.com` and is overridable through `endpoint`. Only R2 is tested.
- **XML:** R2's list and multipart replies are parsed by a minimal, purpose-built reader for exactly those shapes. There is no XML dependency.

### Request flow (single PUT)

```
Browser ── issue {route,input,size,type} ──▶ App (/api/upload)
                                              input → auth → rateLimit → validate
                                              → generate key → backend.issueUpload
Browser ◀── {key,url,headers} ───────────────┘
Browser ── PUT url (signed headers) ──▶ R2 private bucket: pending/<key>
Browser ── confirm {route,key,fileName?} ──▶ App
                                              HEAD → auth(signed input) → rateLimit
                                              → owner → checks → copy → onConfirmed
                                              → receipt → delete pending
Browser ◀── {file} ─────────────────────────┘
```

---

## 2. Server

### 2.1 Client and routes

```ts
import { createR2Client, defineUploads } from "@hiplip/hatid/server";

export const r2 = createR2Client({
  accountId, accessKeyId, secretAccessKey,
  buckets: { private: "myapp-private", public: "myapp-public" }, // private required, public optional
  publicBaseUrl: "https://files.myapp.com",  // required when buckets.public is set
  endpoint: undefined,                        // optional override
  tokenSecret: undefined,                     // optional; see §2.6
});

export const uploads = defineUploads(r2, {
  attachment: {
    visibility: "private",                 // "public" requires buckets.public, else CONFIG error at definition
    prefix: "att",                         // validated at definition: /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/
    maxSize: "500MB",                      // or a number of bytes
    allowedTypes: ["application/octet-stream"], // exact types or "type/*" wildcards
    input: z.object({ noteId: z.string().uuid() }), // optional, any Standard Schema
    datePrefix: true,                      // default true: <yyyy>/<mm>/ segment (UTC)
    keyExtension: false,                   // default false: extension derived from content type
    keyFileName: false,                    // default false: "<uuid>-<cleaned name>"
    expiresIn: "10m",                      // default "10m": lifetime of signed PUT / part URLs
    multipart: { threshold: "100MB", partSize: "10MB", tokenTtl: "24h" }, // defaults shown
    auth: async ({ ctx, input }) => (await getSession(ctx.req))?.userId ?? null, // REQUIRED
    rateLimit: async ({ ctx, owner, action }) => true, // optional; false | { retryAfter } rejects
    onConfirmed: async ({ file, owner, input, metadata, fileName, ctx }) => {
      await db.insert(files).values({ key: file.key /* … */ }).onConflictDoNothing();
    },
  },
}, {
  onError: ({ error, route, action }) => console.error(error), // optional server-side logging
});
```

- **`auth` is required** on every route, and a route without it is a type error and a runtime `CONFIG` error. It returns an owner string (opaque id, no emails or PII; 1–128 chars), `{ owner, metadata }`, or `null` to reject. It runs at issue time **and** at confirm time (and on every multipart call). At confirm it receives the `input` recovered from the signed metadata.
- **`ctx`** ⚠️ (changed from `req`, needs review): hooks receive `{ ctx, … }` instead of `{ req, … }` so the same routes work for both adapters. `defineUploads<TCtx>` is generic over the context type. `createFetchHandler`/`createNextHandler` default `ctx` to `{ req: Request }` and accept a `context: (req) => TCtx` option. The tRPC adapter passes the tRPC context.
- **`rateLimit`** runs after `auth` (so it can key by owner) and before any storage work, for every action: `"issue" | "confirm" | "signParts" | "complete" | "abort"`.
- **`onConfirmed`** runs server-side inside the confirm request after every check passes. It is where apps persist records. It is **at-least-once** (see §2.5): apps must upsert on `file.key`.
- **`metadata`** passed to `onConfirmed` is always the **issue-time** value recovered from the signed object metadata. Any `metadata` returned by `auth` at confirm time is ignored; only its `owner` is used.
- **`metadata`** (from `auth`) and **`input`** are serialized together as `{ input, metadata }` JSON. They must be ≤ 1 KB after encoding, checked at issue time (`INVALID_INPUT` with a clear message). They are stored as **plaintext object metadata**, readable by anyone with bucket access. The docs require identifiers only: never secrets, PII, file names or content.
- **`allowedTypes`**: entries are `type/subtype` or `type/*`. The client's declared content type must be a bare `type/subtype` (no parameters such as `;charset`), lowercased before matching.
- **`file`** passed to `onConfirmed` and returned to the client is `{ key, visibility, size, contentType, url? }`; `url` is present for public files only.

### 2.2 StorageBackend interface (`@experimental`)

`StorageBackend` is exported as a type marked `@experimental — unstable until v1.0` in TSDoc and in the docs. `createR2Client` is the stable public API. Every method takes and returns **plain JSON-serializable data**: no `Request` objects, no callbacks, no class instances. That way a future HTTP backend can implement it by mapping each method to an RPC.

The orchestration (validation, hooks, ordering) lives in `low-level.ts`/`routes.ts`. The backend does storage operations only:

| Method | Purpose |
|---|---|
| `issueUpload({ key, contentType, size, signedMetadata, expiresIn })` | → `{ url, method: "PUT", headers }`, a signed PUT to the private bucket |
| `inspect({ key })` | HEAD pending, then receipt → `{ state: "pending", size, contentType, metadata }` \| `{ state: "confirmed", receipt }` \| `{ state: "missing" }` |
| `promote({ pendingKey, finalKey, visibility, contentType })` | Copy pending → final (public: cross-bucket, metadata REPLACE; private: same bucket, metadata COPY) |
| `writeReceipt({ finalKey, receipt })` | 0-byte object at `receipts/<finalKey>` in the private bucket |
| `deleteObject({ key, bucket })` | `bucket: "private" \| "public"` |
| `deleteObjects({ keys, bucket })` | Batch delete (≤ 1000) |
| `head({ key, bucket })` | → `{ size, contentType, etag, lastModified } \| null` |
| `createDownloadUrl({ key, expiresIn, contentDisposition? })` | Private bucket only |
| `publicUrl({ key })` | → string, from `publicBaseUrl` |
| `createMultipart({ key, contentType, signedMetadata })` | → `{ uploadId }` |
| `signParts({ key, uploadId, parts: [{ partNumber, size }], expiresIn })` | → `[{ partNumber, url, headers }]` |
| `completeMultipart({ key, uploadId, parts: [{ partNumber, etag }] })` | |
| `abortMultipart({ key, uploadId })` | |
| `list({ bucket, prefix, cursor?, limit })` | → `{ objects: [{ key, lastModified }], cursor? }` |
| `listMultipart({ prefix, cursor?, limit })` | → `{ uploads: [{ key, uploadId, initiated }], cursor? }` |
| `signToken({ payload })` / `verifyToken({ token })` | HMAC for multipart tokens (§2.6); the backend holds the secret |

### 2.3 Keys

- Pending: `pending/<prefix>/[<yyyy>/<mm>/]<uuid>[-<cleaned name>][.<ext>]`
- Final: the same string with the leading `pending/` removed.
- Receipt: `receipts/<final key>` (private bucket).
- `<uuid>` is `crypto.randomUUID()`. `<yyyy>/<mm>` is UTC and omitted when `datePrefix: false`.
- `.<ext>` is present only with `keyExtension: true`. It comes from a fixed content-type → extension table and never from the file name. Unknown types get no extension.
- `-<cleaned name>` is present only with `keyFileName: true`. The name is sent at issue time on those routes only, lowercased and reduced to `[a-z0-9._-]`, with runs collapsed and the length capped at 64. The docs warn that the name is public on these routes.
- Keys are **always** generated on the server. Nothing accepts a client-chosen key. Confirm and multipart calls take a key the client was given, and it is validated to be under `pending/<that route's prefix>/` and to match the key grammar. The signed metadata must also name the same route (§2.4).

### 2.4 Signed metadata

Signed into the PUT (or attached at `CreateMultipartUpload`) as `x-amz-meta-hatid-*`:

| Header | Value |
|---|---|
| `x-amz-meta-hatid-v` | `1` |
| `x-amz-meta-hatid-route` | route name (low-level calls: `""`) |
| `x-amz-meta-hatid-owner` | base64url(owner) |
| `x-amz-meta-hatid-visibility` | `public` \| `private` |
| `x-amz-meta-hatid-size` | declared size, in bytes |
| `x-amz-meta-hatid-max-size` | route maxSize, in bytes |
| `x-amz-meta-hatid-type` | declared content type |
| `x-amz-meta-hatid-issued-at` | ms epoch |
| `x-amz-meta-hatid-meta` | base64url(JSON `{ input, metadata }`), ≤ 1 KB |

`Content-Type` is always signed. `Content-Length` is signed to equal the declared size: R2 enforces it (§6, V3, verified). Size is still checked at confirm.

At confirm, an object whose metadata keys differ from exactly this set is `UPLOAD_INVALID` (this guards against unsigned extra metadata if R2 accepts it; §6, V2).

### 2.5 Confirm

`confirmUpload(backend, { key, owner, fileName?, route? })` (low-level), and the `confirm` protocol action (route-level, which derives `owner` from `auth`):

1. `inspect(key)`.
   - `missing` → `CONFIRM_REJECTED`.
   - `confirmed` → jump to the idempotent path (step 9).
2. Decode the signed metadata and recover `input`. The route named in the metadata must equal the route being called, else `CONFIRM_REJECTED`.
3. `auth({ ctx, input })`. `null` → `CONFIRM_REJECTED`, **no delete**.
4. `rateLimit({ ctx, owner, action: "confirm" })`.
5. Owner from `auth` ≠ signed owner → `CONFIRM_REJECTED`, **no delete**.
6. Checks. On any failure, **delete the pending object** → `UPLOAD_INVALID`:
   - actual size == signed `size` and ≤ signed `max-size`;
   - actual Content-Type == signed `type`, and it is still in the route's current `allowedTypes`;
   - metadata version is `1` and the key set is exact.
7. `promote` to the final key. For public files this copies across buckets with metadata **REPLACE**, keeping only Content-Type (plus `Cache-Control` if configured). No owner, no hash, no input. If some future feature needs ownership on a public object, it must be raised with Philip first.
8. `onConfirmed({ file, owner, input, metadata, fileName, ctx })`. If it throws: delete the final copy, report through `onError`, and return `HOOK_FAILED` (retryable). The pending object is untouched, so a retry re-runs from step 1.
9. Write the receipt `{ owner, visibility, finalKey, size, contentType, route }`, then delete the pending object, then return `{ file }`.

**Idempotent path:** if the pending object is gone and a receipt exists, run `auth` and `rateLimit`, require that the owner equals the receipt owner (else `CONFIRM_REJECTED`), and return `{ file }` from the receipt **without** re-running `onConfirmed`.

**At-least-once:** a crash between step 8 and step 9 means a retry re-runs `onConfirmed`. This is documented; apps upsert on `key`.

**Existence oracle:** a missing key, `auth` → `null` and an owner mismatch all return the same `CONFIRM_REJECTED` (404), so callers can't probe whether keys exist.

**`fileName`:** optional, sent by the client at confirm, never stored in object metadata. It is cleaned (NFC, strip control characters and `/` `\`, trim, ≤ 1024 chars) and passed to `onConfirmed` as an untrusted, cosmetic value. It is never used for keys, paths or content-type decisions. Nimbus may send a base64url ciphertext or omit it.

**Copy size limits:** `promote` uses CopyObject up to 5 GiB and UploadPartCopy above that, subject to the R2 test (§6, V5–V6).

### 2.6 Multipart

- **When.** Used when `size > multipart.threshold` (default 100 MB; must be < 5 GiB).
- **Part plan.** Part size defaults to 10 MB and grows to `ceil(size / 10000)` rounded up to 1 MiB if needed. Every part except the last is the same size, as R2 requires. The minimum part size is 5 MiB.
- **Issue.** Runs the same checks as single PUT, then `createMultipart` with the signed metadata attached server-side. It returns `{ kind: "multipart", key, uploadId, partSize, partCount, token }`.
- **Token.** `base64url(JSON { key, uploadId, owner, route, exp }) + "." + base64url(HMAC-SHA256)`.
  - The HMAC key is `tokenSecret` if given, otherwise derived as `HMAC-SHA256(secretAccessKey, "hatid/multipart-token/v1")`.
  - `exp` = now + `tokenTtl` (default 24h).
  - The token is the only ownership proof while the upload is unfinished, because metadata can't be read from an incomplete multipart upload.
- **`signParts` / `complete` / `abort`.** Each verifies the token (signature, expiry, key, uploadId, route), runs `auth` (the owner must equal the token's owner), then runs `rateLimit`. A failure is `CONFIRM_REJECTED`.
- **`signParts`.** Signs part URLs in batches requested by the client (≤ 100 per call), each with its exact `Content-Length`.
- **`complete`.** `completeMultipart`, then the full confirm flow (§2.5) in the same request. If confirm fails after a successful complete, the client retries with a plain `confirm`.

### 2.7 Downloads, public URLs, head and delete

- `createDownloadUrl(r2, { key, expiresIn = "5m", downloadName?, inline = false })` signs a GET on the private bucket. `downloadName` becomes `Content-Disposition: attachment|inline; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987 percent-encoded>`, passed as `response-content-disposition`.
- `publicUrl(r2, key)` returns `${publicBaseUrl}/${encodeURI-safe key}`, or throws `CONFIG` without `publicBaseUrl`.
- `headFile(r2, { key, visibility })` and `deleteFile(r2, { key, visibility })` do **no authorization**. The app checks ownership in its own DB first (documented).
- All of these reject keys under `pending/` or `receipts/` (`INVALID_INPUT`).

### 2.8 Cleanup

`cleanupUnconfirmed(r2, { olderThan = "24h", receiptTtl = "7d", limit = 500, dryRun = false })` → `{ deleted: { pending, receipts, multipart }, done }`.

- It lists `pending/` and deletes objects whose **LastModified** is older than `olderThan`. LastModified is always ≥ `issued-at`, so this is never more aggressive, and it needs no per-object HEAD.
- It lists `receipts/` and deletes those older than `receiptTtl`.
- It lists in-progress multipart uploads under `pending/` and aborts those initiated before `olderThan`.
- `limit` caps the total number of R2 subrequests per call (Workers allow 50 subrequests per invocation on free plans, 1000 on paid). `done: false` means there is more to do next run.
- **Lifecycle rules:** the README also documents R2 bucket lifecycle rules as a zero-code backstop: expire `pending/` after 1 day and `receipts/` after 7 days, and abort incomplete multipart uploads after 1 day.

### 2.9 Errors

`class HatidError extends Error { code; status; retryable; retryAfter? }`

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `CONFIG` | 500 | no | Misconfiguration (thrown at definition/startup where possible) |
| `INVALID_INPUT` | 400 | no | Malformed request, input schema failure, metadata > 1 KB, bad key |
| `FILE_TOO_LARGE` | 413 | no | Declared size > maxSize, or size ≤ 0 |
| `INVALID_TYPE` | 415 | no | Type not in allowedTypes, or has parameters |
| `UNAUTHORIZED` | 401 | no | `auth` returned `null` at **issue** time |
| `RATE_LIMITED` | 429 | yes | `rateLimit` rejected; `retryAfter` seconds if given |
| `CONFIRM_REJECTED` | 404 | no | Missing key, `auth` failed, owner mismatch, bad token (deliberately the same) |
| `UPLOAD_INVALID` | 422 | no | Owner's upload failed size/type/metadata checks; the object was deleted |
| `HOOK_FAILED` | 500 | yes | `onConfirmed` threw; the final copy was removed |
| `STORAGE` | 502 | yes | R2 error |

Wire format: `{ "error": { "code", "message", "retryAfter"? } }`. For `STORAGE` and `HOOK_FAILED` the client gets a generic message, and the cause goes to `onError`.

### 2.10 Safety rules (each one gets a test)

1. Keys are generated only on the server; client-supplied keys are only accepted when they are a previously issued key, validated against route prefix and grammar.
2. `confirmUpload` is the only source of truth. The client's "done" is never trusted.
3. `auth` is required on every route; there is no anonymous default.
4. `owner` always comes from server-side `auth`, never from the client.
5. Size and type are validated at issue and re-validated against the real object at confirm.
6. Unconfirmed files are never publicly reachable: everything lands in `pending/` in the **private** bucket.
7. Public copies carry no owner, input or app metadata.
8. A non-owner can never cause deletion of someone else's object.
9. Tampered signed metadata is rejected (by R2's signature check, verified live, and by the fake R2 in unit tests).
10. Missing, unauthorized and foreign keys are indistinguishable at confirm.
11. The input and metadata cap (1 KB) is enforced at issue.
12. File names never reach keys (unless `keyFileName`) or object metadata.

---

## 3. Client — `@hiplip/hatid/react` ⚠️ needs review

```tsx
import { useUpload, Dropzone, httpTransport } from "@hiplip/hatid/react";
import type { uploads } from "@/server/uploads"; // type-only import, no server code in the bundle

const transport = httpTransport<typeof uploads>("/api/upload");

function Attachments({ noteId }: { noteId: string }) {
  const { upload, items, progress, status, cancel, retry, reset } = useUpload({
    transport,
    route: "attachment",          // typo → type error
    input: { noteId },            // typed from the route's input schema
    maxFiles: 5,                  // client-side UX limit only
    concurrency: 3,               // files in parallel (default 3)
    onComplete: (result) => {},   // per file, UI only
    onAllComplete: (results) => {}, // when the batch settles (successes + errors)
  });

  return (
    <Dropzone upload={upload} accept={["image/*"]} maxFiles={5} maxSize="10MB">
      {({ getRootProps, getInputProps, isDragActive, open }) => (
        <div {...getRootProps()}><input {...getInputProps()} />Drop files</div>
      )}
    </Dropzone>
  );
}
```

- **Transport.** `useUpload({ getUploadUrl, confirm })` from the original sketch becomes a `transport` object `{ issue, confirm, signParts, complete, abort }`. `httpTransport` (any `createFetchHandler`, including Next and Workers) and `trpcTransport` implement it. Custom transports are plain objects.
- **`upload(sources, opts?)`.**
  - `sources` is `UploadSource | UploadSource[]`, where `UploadSource = File | Blob | ArrayBuffer | { data: Blob | ArrayBuffer; type?: string; fileName?: string }`.
  - An ArrayBuffer with no type uploads as `application/octet-stream`. This is how apps encrypt before uploading.
  - `opts.input` overrides the hook-level input for this batch.
  - It returns a promise of the batch results.
- **`items`.** `{ id, fileName?, size, type, status, progress /* 0–1 */, loaded, error?: HatidError, result?: UploadedFile }`. Item status runs `queued → issuing → uploading → confirming → success`, or `error` / `canceled`.
- **Totals.** `progress` is bytes-weighted across active items. `status` is `idle | uploading | success | error`.
- **Fail fast.** An issue-time rejection marks that item `error` with the typed error immediately, and the rest of the queue continues.
- **`retry(id)`.** Only for `retryable` errors. If the PUT succeeded but confirm failed, it re-sends only `confirm`. Otherwise it re-issues and re-uploads that item. Successful items are never re-uploaded.
- **`cancel(id?)`.** Aborts the XHR or parts. For multipart it also calls `abort`. An orphaned pending object is left to cleanup.
- **`maxFiles`.** Excess files in a batch become client-side `error` items (`TOO_MANY_FILES`, a client-only code). The docs say the server doesn't enforce batch counts; each file is its own issue/confirm, and abuse is handled by `rateLimit`.
- **`onAllComplete(results)`.** Fires when every item of an `upload()` batch has settled, and again if a retried item later settles.
- **XHR.** Used for upload progress (fetch has no upload progress), sending the signed `headers` exactly as returned.
- **Multipart in the browser.**
  - Parts are uploaded with 4-way part concurrency per file.
  - Each part retries automatically 3 times with backoff.
  - The client requests part URLs in batches from `signParts`.
  - Progress aggregates the bytes of every part into one percentage per item.
  - ETags are read from the response header, which needs `ExposeHeaders: ["ETag"]` in CORS.
- **`<Dropzone/>`.** Headless, a render prop with props getters. It is unstyled and easy to wrap with shadcn/ui. `accept`, `maxSize` and `maxFiles` are client-side hints; the server enforces the real limits. It supports click-to-open, drag and drop, and keyboard (Enter/Space on the root).

---

## 4. Adapters ⚠️ needs review

### 4.1 Fetch, Workers and Next.js

```ts
// server/uploads.ts (Workers or Node)
import { createFetchHandler } from "@hiplip/hatid/server";
export const handleUpload = createFetchHandler(uploads, { context: (req) => ({ req }) });
// Workers: if (url.pathname === "/api/upload") return handleUpload(req);

// app/api/upload/route.ts (Next.js App Router, node or edge runtime)
import { createNextHandler } from "@hiplip/hatid/next";
export const { POST } = createNextHandler(uploads);
```

- **Protocol.** `POST` JSON `{ action, route, … }`. Actions: `issue`, `confirm`, `signParts`, `complete`, `abort`.
- **Request checks.** Requests must have `Content-Type: application/json`, which blocks simple cross-site form POSTs; anything else gets `415`. The body is capped at 64 KB. Errors use the §2.9 wire format and status codes.
- **Next adapter.** `createNextHandler` wraps `createFetchHandler`. It has no Next-specific logic beyond the export shape.

### 4.2 tRPC

```ts
// server/routers/upload.ts
import { createUploadRouter } from "@hiplip/hatid/trpc";
export const uploadRouter = createUploadRouter({ t, procedure: protectedProcedure, uploads });
// appRouter = t.router({ upload: uploadRouter, … })

// client
import { trpcTransport } from "@hiplip/hatid/trpc";
const transport = trpcTransport(trpcClient.upload); // vanilla tRPC client proxy
```

- **Router.** `createUploadRouter` builds five mutations on the given procedure, using a passthrough input parser; `protocol.ts` does the validation. Hook `ctx` is the tRPC context.
- **Auth.** `auth` is still required on every route, even with `protectedProcedure`.
- **Types.** Route names and input types are inferred from `uploads` through the router type.

---

## 5. Quality, build, release and docs ⚠️ needs review

- **TypeScript.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- **Tests (Vitest).** Written TDD.
  - `core/`: pure unit tests.
  - Server: a **fake R2**. It is an in-memory S3 subset behind a `fetch` mock that **verifies SigV4** by re-signing each received request with aws4fetch, using the same credentials and timestamp.
  - React: `@testing-library/react` + happy-dom, with a fake XHR.
- **Backend contract suite.** `runBackendContract(makeBackend)` covers:
  - the happy path: issue → upload → confirm → downloadUrl → delete → cleanup;
  - the failure cases: oversize, wrong type, wrong owner, tampered metadata, expired URL, idempotent re-confirm, and `onConfirmed` failure followed by a retry.

  It runs against the fake R2 in `pnpm test`, and against the real `hatid-sandbox` buckets in `pnpm test:integration`, which is skipped unless the `R2_*` env vars are set.
- **Build.** tsup (ESM + `.d.ts`, one entry per subpath), checked in CI with `publint` and `@arethetypeswrong/cli`.
- **Tooling.** pnpm workspace (the root package plus `examples/*`), and changesets for versioning.
- **CI (`.github/workflows/ci.yml`).** On PRs and pushes: typecheck, test and build on Node 20 and 22.
- **Release (`.github/workflows/release.yml`).**
  - `changesets/action` opens a version PR, and merging it publishes.
  - Publishing uses **npm trusted publishing (OIDC)**: `permissions: id-token: write`, npm CLI ≥ 11.5.1, no `NPM_TOKEN`, no OTP. Provenance is automatic.
  - One-time setup on npmjs.com: add a trusted publisher for `Hiplip/hatid` + `release.yml`.
  - Whether `changeset publish` under pnpm goes through an npm CLI that supports OIDC must be verified while implementing. If it doesn't, the publish step calls `npm publish` directly.
- **README.**
  - What hatid is and isn't.
  - Two-bucket setup. The private bucket must **never** have a custom domain or r2.dev access; the public bucket gets the custom domain.
  - API token scope: **Object Read & Write** on both buckets, nothing more. The app token never gets Admin / bucket-settings rights.
  - The CORS JSON:
    ```json
    [{ "AllowedOrigins": ["https://your.app", "http://localhost:3000"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["Content-Type", "x-amz-meta-hatid-v", "x-amz-meta-hatid-route",
         "x-amz-meta-hatid-owner", "x-amz-meta-hatid-visibility", "x-amz-meta-hatid-size",
         "x-amz-meta-hatid-max-size", "x-amz-meta-hatid-type", "x-amz-meta-hatid-issued-at",
         "x-amz-meta-hatid-meta"],
       "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
    ```
    It lists the headers explicitly (§6, V8 was not tested: least privilege). CORS is set once per bucket in the Cloudflare dashboard, not by the app. The public bucket gets a GET-only CORS rule.
  - Lifecycle rules.
  - Usage on Next.js/Vercel and on Workers.
  - Rate limiting: the Cloudflare Workers Rate Limiting binding, and `@upstash/ratelimit` on Vercel.
  - The plaintext-metadata warning, at-least-once `onConfirmed`, and that `headFile`/`deleteFile` do no auth.
- **`examples/next`.**
  - Covers upload with progress, confirm, list, download, delete, and an oversize file rejected at issue.
  - Uses a demo-only cookie "session" (clearly labelled) to satisfy `auth`, and a JSON-file store (`.data/files.json`, gitignored) for the list.
  - Reads `.env` and ships `.env.example`.
- **`examples/cleanup-worker`.** A Workers cron trigger (`0 * * * *`) calling `cleanupUnconfirmed({ olderThan: "24h" })` until `done`, within its `limit`.

---

## 6. Live R2 verification (run first; decides details above)

These checks ran as a throwaway test against `hatid-sandbox` (private) and `hatid-sandbox-public` on 2026-10-08. The code is not committed and objects went under `hatid-spike/`. Requirements: `.env` or environment with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`.

| # | Question | If yes | If no | Observed |
|---|---|---|---|---|
| V1 | PUT with altered signed `x-amz-meta-*` values is rejected (403)? | Expected. Keep the design | **Stop**: the design depends on it; report to Philip | ✅ altered → 403 |
| V2 | PUT with extra **unsigned** `x-amz-meta-*` headers is rejected? | Exact-key-set check stays as defense in depth | Exact-key-set check at confirm is the guard | ✅ rejected (403) |
| V3 | Body ≠ signed `Content-Length` is rejected? | Sign Content-Length | Don't sign it; rely on confirm-time size check | ✅ enforced → sign Content-Length |
| V4 | Expired pre-signed URL is rejected? | Expected | **Stop** and report | ✅ 403 |
| V5 | Cross-bucket CopyObject within one account works, including metadata REPLACE? | Keep the design | **Stop and ask Philip** before choosing a fallback (a streaming GET→PUT costs Worker CPU/time) | ✅ 200, public copy has no `x-amz-meta-*` (first run 403 was token scope; fixed) |
| V6 | Max CopyObject size; is UploadPartCopy supported? | Use the measured limit | Document the max confirmable size | ✅ UploadPartCopy works (6 MiB as 2 parts). Max single CopyObject not measured; 5 GiB assumed |
| V7 | `DeleteObjects` (batch) and `ListMultipartUploads` supported? | Use them | Fall back to single deletes / lifecycle rules | ✅ both 200 |
| V8 | Does R2 CORS accept a wildcard `x-amz-meta-hatid-*` in AllowedHeaders? | Short CORS JSON | Explicit list (above) | Not tested (least privilege: token has no bucket-settings rights) → explicit list |

Results are recorded in `docs/specs/2026-10-08-r2-verification.md`, and this spec is updated to match.

---

## 7. After v1 (separate follow-up plans, not in this spec)

1. **Hiplip/saas-starter:** env vars, a tRPC upload router, and a Drizzle `files` table (`key` unique, size, type, owner, createdAt) upserted in `onConfirmed`.
2. **Hiplip/nimbus:** E2E-encrypted attachments.
   - Encrypt on the client and upload an ArrayBuffer as `application/octet-stream`.
   - Routes use `datePrefix: false` and no file name or extension in keys.
   - `input` holds identifiers only.
   - `fileName` is either an encrypted base64url string or omitted.
