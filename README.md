# hatid

Direct-to-R2 file uploads for React and the edge. Your bucket, your rules.

*Hatid* is Filipino for "to deliver". hatid signs short-lived upload URLs on your server, the browser sends the file straight to your Cloudflare R2 bucket, and your server confirms what actually arrived before anything is treated as uploaded. It is a library, not a service: no dashboard, no API keys, no billing and no multi-tenancy. Everything runs inside your own app. It is built on [Cloudflare R2](https://developers.cloudflare.com/r2/) (10 GB free, free egress) and works with any S3-compatible endpoint through the `endpoint` option, though only R2 is tested.

- Runs on Cloudflare Workers and Node 20+ (including Vercel). Signing uses `aws4fetch`, not the AWS SDK.
- `@hiplip/hatid/react`: `useUpload` hook, headless `<Dropzone>`, progress, retry, cancel, automatic multipart for big files.
- `@hiplip/hatid/next`, `@hiplip/hatid/server` (fetch handler), `@hiplip/hatid/trpc`: pick your transport.
- Route names and `input` types are checked end to end in TypeScript.

## Contents

1. [How it works](#how-it-works)
2. [Install](#install)
3. [R2 setup](#r2-setup)
4. [Define routes](#define-routes)
5. [Next.js (Vercel)](#nextjs-vercel)
6. [Cloudflare Workers](#cloudflare-workers)
7. [tRPC](#trpc)
8. [Downloads and deletes](#downloads-and-deletes)
9. [Encrypt before upload](#encrypt-before-upload)
10. [Rate limiting](#rate-limiting)
11. [Cleanup](#cleanup)
12. [Errors](#errors)
13. [What hatid is not](#what-hatid-is-not)
14. [Contributing and testing](#contributing-and-testing)
15. [License](#license)

## How it works

```
Browser ── issue {route,input,size,type} ──▶ Your server (/api/upload)
                                              input → auth → rateLimit → validate
                                              → generate key → sign PUT
Browser ◀── {key,url,headers} ───────────────┘
Browser ── PUT url (signed headers) ──▶ R2 private bucket: pending/<key>
Browser ── confirm {route,key,fileName?} ──▶ Your server
                                              HEAD → auth(signed input) → rateLimit
                                              → owner → checks → copy → onConfirmed
                                              → receipt → delete pending
Browser ◀── {file} ─────────────────────────┘
```

Every upload lands in `pending/` in your **private** bucket first. Only a successful confirm promotes it to its final key (and, for public routes, to the public bucket). The safety rules, each covered by tests:

- Keys are generated only on the server. A client can only refer to a key it was issued, validated against the route prefix.
- `confirm` is the only source of truth. The client saying "done" is never trusted.
- `auth` is required on every route. There is no anonymous default.
- `owner` always comes from your server-side `auth`, never from the client.
- Size and type are validated at issue and re-validated against the real object at confirm.
- Unconfirmed files are never publicly reachable.
- Public copies carry no owner, input or app metadata. Only `Content-Type` is kept.
- A non-owner can never cause deletion of someone else's object.
- Tampered signed metadata is rejected (by R2's signature check, verified live, and again at confirm).
- A missing key, a failed `auth` and someone else's key all return the same `CONFIRM_REJECTED` (404), so nobody can probe which keys exist.
- `input` plus `auth` metadata is capped at 1 KB, checked at issue.
- File names never reach keys (unless you opt in with `keyFileName`) or object metadata.

## Install

```sh
npm i @hiplip/hatid
```

ESM only. Optional peer dependencies, install only what you use:

| Subpath | Needs |
|---|---|
| `@hiplip/hatid/server` | nothing (runtime dependency: `aws4fetch`) |
| `@hiplip/hatid/react` | `react` >= 18 |
| `@hiplip/hatid/next` | `next` >= 14 (App Router) |
| `@hiplip/hatid/trpc` | `@trpc/server` and `@trpc/client` >= 11 |

## R2 setup

1. **Create two buckets**, for example `myapp-private` and `myapp-public`. The public bucket is optional and only needed for routes with `visibility: "public"`.
   - The private bucket must **never** have a custom domain or r2.dev access enabled.
   - The public bucket gets a custom domain: R2 -> bucket -> Settings -> Custom Domains (for example `files.myapp.com`). That domain is your `publicBaseUrl`.
2. **Create an R2 API token** with **Object Read & Write**, scoped to those two buckets and nothing more. Record the Account ID, Access Key ID and Secret Access Key. The app never needs Admin or bucket-settings rights, and must not be given them.
3. **Configure CORS once per bucket in the Cloudflare dashboard** (R2 -> bucket -> Settings -> CORS policy). hatid never changes bucket settings itself. Edit the origins to match your app.

   Private bucket (browsers PUT here, and GET/HEAD presigned downloads):

   ```json
   [
     {
       "AllowedOrigins": ["https://your.app", "http://localhost:3000"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["Content-Type", "x-amz-meta-hatid-v", "x-amz-meta-hatid-route",
         "x-amz-meta-hatid-owner", "x-amz-meta-hatid-visibility", "x-amz-meta-hatid-size",
         "x-amz-meta-hatid-max-size", "x-amz-meta-hatid-type", "x-amz-meta-hatid-issued-at",
         "x-amz-meta-hatid-meta"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Public bucket (GET only; browsers never upload to it):

   ```json
   [
     {
       "AllowedOrigins": ["https://your.app", "http://localhost:3000"],
       "AllowedMethods": ["GET"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Without these headers listed, browser uploads fail CORS. Without `ETag` exposed, multipart uploads fail with a clear error. The headers are listed explicitly because wildcard `x-amz-meta-hatid-*` matching was not verified against R2.
4. **Lifecycle rules** (optional backstop, see also [Cleanup](#cleanup)) on the private bucket: delete objects with prefix `pending/` after 1 day, delete `receipts/` after 7 days, and abort incomplete multipart uploads after 1 day.

Note: hatid reads object sizes with `accept-encoding: identity` because R2 gzips HEAD responses for compressible types. You don't need to do anything about it.

## Define routes

```ts
// server/uploads.ts
import { createR2Client, defineUploads } from "@hiplip/hatid/server";
import { z } from "zod";
import { getSession } from "./auth";
import { db, files } from "./db";

export const r2 = createR2Client({
  accountId: process.env.R2_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  buckets: { private: "myapp-private", public: "myapp-public" }, // private required, public optional
  publicBaseUrl: "https://files.myapp.com", // required when buckets.public is set
  // endpoint: "https://...",  // optional override (default https://<accountId>.r2.cloudflarestorage.com)
  // tokenSecret: "...",       // optional; multipart tokens are derived from the R2 secret by default
});

export const uploads = defineUploads(r2, {
  attachment: {
    visibility: "private",
    prefix: "att",
    maxSize: "500MB", // or a number of bytes; units are 1024-based (1 MB = 1024 * 1024 bytes)
    allowedTypes: ["image/*", "application/pdf"],
    input: z.object({ noteId: z.string().uuid() }), // optional, any Standard Schema (zod, valibot, arktype...)
    // Required. Return an owner id, { owner, metadata }, or null to reject.
    auth: async ({ ctx }) => (await getSession(ctx.req))?.userId ?? null,
    // Optional. Return true, false, or { retryAfter } (seconds) to reject.
    rateLimit: async ({ owner, action }) => checkRate(owner, action),
    onConfirmed: async ({ file, owner, input, fileName }) => {
      // At-least-once: upsert on file.key.
      await db.insert(files)
        .values({ key: file.key, owner, noteId: input.noteId, size: file.size, name: fileName ?? null })
        .onConflictDoNothing();
    },
  },
  avatar: {
    visibility: "public", // needs buckets.public, else a CONFIG error at definition
    prefix: "avatars",
    maxSize: "2MB",
    allowedTypes: ["image/png", "image/jpeg", "image/webp"],
    auth: async ({ ctx }) => (await getSession(ctx.req))?.userId ?? null,
    onConfirmed: async ({ file, owner }) => {
      await db.insert(files).values({ key: file.key, owner, url: file.url! }).onConflictDoNothing();
    },
  },
}, {
  onError: ({ error, route, action }) => console.error("hatid", route, action, error), // server-side logging
});

declare function checkRate(owner: string, action: string): Promise<boolean>;
```

Rules worth knowing:

- **`auth` is required** on every route (a type error and a runtime `CONFIG` error otherwise). It runs at issue time and again at confirm time, and on every multipart call. Return `null` to reject. Don't throw: a throw surfaces as a 500 `INTERNAL`, not a clean `UNAUTHORIZED`.
- **`onConfirmed` is at-least-once.** If your process dies after it runs but before the receipt is written, a retry runs it again. Upsert on `file.key`. If it throws, the final copy is removed and the client can retry (`HOOK_FAILED`).
- **`input` and `metadata` are plaintext object metadata**, readable by anyone with bucket access. Put identifiers only in them: never secrets, PII, file names or file content. Together they must stay under 1 KB (checked at issue).
- **`maxSize` uses 1024-based units**: `"2MB"` is 2,097,152 bytes. `KiB`, `MiB` and `GiB` are accepted as aliases, and a plain number means bytes.
- **`allowedTypes`** takes exact types or `type/*`. `*/*` is not allowed. The client's content type must be a bare `type/subtype` (no `;charset=...`). Avoid `image/svg+xml` on public routes unless your public domain is isolated from your app, because SVG can carry script.
- Other options: `datePrefix` (default `true`, adds `<yyyy>/<mm>/` to keys), `keyExtension` (default `false`), `keyFileName` (default `false`; makes the cleaned file name part of the key, so it becomes public on public routes), `expiresIn` (default `"10m"`), `multipart: { threshold, partSize, tokenTtl }` (defaults `"100MB"`, `"10MB"`, `"24h"`).
- `onConfirmed` receives `{ file, owner, input, metadata, fileName, ctx }`. `file` is `{ key, visibility, size, contentType, url? }` (`url` only for public files). `fileName` is untrusted and cosmetic: it comes from the client at confirm time and is never used for keys or content-type decisions.

## Next.js (Vercel)

```ts
// app/api/upload/route.ts
import { createNextHandler } from "@hiplip/hatid/next";
import { uploads } from "@/server/uploads";

export const { POST } = createNextHandler(uploads);
```

The default hook context is `{ req: Request }`. Pass `{ context: (req) => ... }` as a second argument to build your own.

```tsx
// app/attachments.tsx
"use client";
import { Dropzone, httpTransport, useUpload } from "@hiplip/hatid/react";
import type { uploads } from "@/server/uploads"; // type-only: no server code in the bundle

const transport = httpTransport<typeof uploads>("/api/upload");

export function Attachments({ noteId }: { noteId: string }) {
  const { upload, items, progress, status, cancel, retry, reset } = useUpload({
    transport,
    route: "attachment",  // a typo here is a type error
    input: { noteId },    // typed from the route's input schema
    maxFiles: 5,          // client-side UX limit only
    onAllComplete: (results) => console.log("batch settled", results),
  });

  return (
    <div>
      <Dropzone upload={upload} accept={["image/*", "application/pdf"]} maxFiles={5} maxSize="10MB">
        {({ getRootProps, getInputProps, isDragActive }) => (
          <div {...getRootProps()}>
            <input {...getInputProps()} />
            {isDragActive ? "Drop to upload" : "Drop files here or click to choose"}
          </div>
        )}
      </Dropzone>

      <p>Overall: {Math.round(progress * 100)}% ({status})</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.fileName ?? "(blob)"}: {item.status} {Math.round(item.progress * 100)}%
            {item.status === "uploading" && <button onClick={() => cancel(item.id)}>Cancel</button>}
            {item.error?.retryable && <button onClick={() => void retry(item.id)}>Retry</button>}
          </li>
        ))}
      </ul>
      <button onClick={reset}>Clear finished</button>
    </div>
  );
}
```

`accept`, `maxSize` and `maxFiles` on `<Dropzone>` and `useUpload` are client-side hints. The server enforces the real limits, and it does not count files per batch: every file is its own issue and confirm, so use `rateLimit` against abuse. Files over the multipart threshold are split into parts automatically, with progress aggregated per file.

A complete app (progress, confirm, list, download, delete, oversize rejection) lives in [`examples/next`](examples/next).

## Cloudflare Workers

```ts
// src/index.ts
import { createFetchHandler, createR2Client, defineUploads } from "@hiplip/hatid/server";
import { getUserId } from "./session";

type Env = {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
};

// Build from `env` (secrets), never at module top level: env only exists inside a request.
function build(env: Env) {
  const r2 = createR2Client({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    buckets: { private: env.R2_PRIVATE_BUCKET },
  });
  const uploads = defineUploads(r2, {
    attachment: {
      visibility: "private",
      prefix: "att",
      maxSize: "50MB",
      allowedTypes: ["image/*", "application/pdf"],
      auth: ({ ctx }) => getUserId(ctx.req, env),
      onConfirmed: async ({ file, owner }) => {
        console.log("confirmed", file.key, owner); // persist to D1 / KV / your DB, upserting on file.key
      },
    },
  });
  return createFetchHandler(uploads);
}

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/upload") {
      handler ??= build(env); // created lazily from env, then reused
      return handler(req);
    }
    return new Response("Not found", { status: 404 });
  },
};
```

Set the credentials as Worker secrets (`wrangler secret put R2_ACCOUNT_ID`, and so on). `createR2Client` must be created per request or lazily from `env`, as above, because bindings and secrets are not available at module scope. The fetch handler is a plain `(Request) => Promise<Response>`, so it also works in Hono, Bun and Deno.

The handler only accepts `POST` with `Content-Type: application/json` (anything else gets `415`) and caps request bodies at 64 KB.

## tRPC

```ts
// server/trpc.ts
import { defineUploads } from "@hiplip/hatid/server";
import { createUploadRouter } from "@hiplip/hatid/trpc";
import { initTRPC, TRPCError } from "@trpc/server";
import { r2 } from "./uploads";

type Context = { userId: string | null };

const t = initTRPC.context<Context>().create();
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx });
});

// Hook `ctx` is your tRPC context.
export const uploads = defineUploads.withContext<Context>()(r2, {
  attachment: {
    visibility: "private",
    prefix: "att",
    maxSize: "50MB",
    allowedTypes: ["image/*", "application/pdf"],
    auth: ({ ctx }) => ctx.userId, // still required even behind protectedProcedure
    onConfirmed: async ({ file }) => {
      console.log("confirmed", file.key); // upsert on file.key
    },
  },
});

export const appRouter = t.router({
  upload: createUploadRouter({ t, procedure: protectedProcedure, uploads }),
});
export type AppRouter = typeof appRouter;
```

```tsx
// client
import { useUpload } from "@hiplip/hatid/react";
import { trpcTransport } from "@hiplip/hatid/trpc";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter, uploads } from "../server/trpc";

const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] });
const transport = trpcTransport<typeof uploads>(trpcClient.upload);

export function useAttachmentUpload() {
  return useUpload({ transport, route: "attachment" }); // route names are checked here
}
```

`createUploadRouter` adds five mutations (`issue`, `confirm`, `signParts`, `complete`, `abort`). The router keeps those five keys in its type, so `trpcClient.upload` from a real tRPC client goes straight into `trpcTransport` with no cast. The procedures themselves take untyped input (hatid has no `@trpc/server` type dependency), so the route checks happen on the client: passing `typeof uploads` to `trpcTransport` makes `useUpload` check route names and `input` shapes. `auth` is still required on every route, even behind `protectedProcedure`, because it is what binds an upload to its owner at issue and confirm.

## Downloads and deletes

```ts
import { createDownloadUrl, deleteFile, headFile, publicUrl } from "@hiplip/hatid/server";
import { getSession } from "./auth";
import { db, files } from "./db";
import { r2 } from "./uploads";

export async function downloadLink(req: Request, key: string): Promise<string | null> {
  const session = await getSession(req);
  const row = await db.findFile(key);
  if (!session || !row || row.owner !== session.userId) return null; // YOU check ownership

  return createDownloadUrl(r2, {
    key,
    expiresIn: "5m",           // default "5m"
    downloadName: row.name,    // sets Content-Disposition: attachment; filename=...
    // inline: true,           // inline instead of attachment
  });
}

export async function removeFile(req: Request, key: string): Promise<void> {
  const session = await getSession(req);
  const row = await db.findFile(key);
  if (!session || !row || row.owner !== session.userId) throw new Error("Not found");

  await deleteFile(r2, { key, visibility: "private" });
  await db.delete(files, key);
}

export async function sizeOf(key: string) {
  return headFile(r2, { key, visibility: "private" }); // { size, contentType, etag, lastModified } | null
}

export const avatarUrl = (key: string) => publicUrl(r2, key); // `${publicBaseUrl}/${key}`; throws CONFIG without publicBaseUrl
```

`createDownloadUrl`, `publicUrl`, `headFile` and `deleteFile` do **no authorization**. They take whatever key you give them. Check ownership in your own database first, as above. They refuse keys under `pending/` and `receipts/`.

## Encrypt before upload

For end-to-end encrypted files, encrypt in the browser and upload the ciphertext. An `ArrayBuffer` or `Uint8Array` with no type is uploaded as `application/octet-stream`.

```ts
// server/vault.ts: keep keys free of anything identifying
import { defineUploads } from "@hiplip/hatid/server";
import { getSession } from "./auth";
import { db, files } from "./db";
import { r2 } from "./uploads";

export const vaultUploads = defineUploads(r2, {
  vault: {
    visibility: "private",
    prefix: "vault",
    datePrefix: false,  // no upload date in the key
    maxSize: "500MB",
    allowedTypes: ["application/octet-stream"],
    auth: async ({ ctx }) => (await getSession(ctx.req))?.userId ?? null,
    onConfirmed: async ({ file, owner, fileName }) => {
      // fileName, if sent, is whatever the client sent: here an encrypted, base64url-encoded name.
      await db.insert(files).values({ key: file.key, owner, name: fileName ?? null }).onConflictDoNothing();
    },
  },
});
```

```tsx
// client/vault.tsx
"use client";
import { httpTransport, useUpload } from "@hiplip/hatid/react";
import type { vaultUploads } from "../server/vault";

const transport = httpTransport<typeof vaultUploads>("/api/vault");

async function encrypt(plain: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return out.buffer;
}

export function useVaultUpload(key: CryptoKey) {
  const { upload, ...rest } = useUpload({ transport, route: "vault" });
  const uploadEncrypted = async (file: File, encryptedName?: string) => {
    const data = await encrypt(await file.arrayBuffer(), key); // no type: uploads as application/octet-stream
    // fileName only if it is already encrypted (base64url); omit it otherwise.
    return upload(encryptedName ? { data, fileName: encryptedName } : data);
  };
  return { uploadEncrypted, ...rest };
}
```

Guidelines: set `datePrefix: false`, never use `keyFileName` or `keyExtension` on these routes, keep file names out of `input` and `metadata`, and send `fileName` only if it is already encrypted (base64url) or leave it out.

## Rate limiting

`rateLimit` runs after `auth` (so you can key by owner) and before any storage work, for every action: `"issue" | "confirm" | "signParts" | "complete" | "abort"`. Return `true` to allow, `false` to reject, or `{ retryAfter }` (seconds) to reject with `RATE_LIMITED`.

**Cloudflare Workers**: use the [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

```toml
# wrangler.toml
[[unsafe.bindings]]
name = "UPLOAD_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
```

```ts
import { createR2Client, defineUploads } from "@hiplip/hatid/server";
import { getUserId } from "./session";

type Env = {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
  UPLOAD_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
};

export function buildUploads(env: Env) {
  const r2 = createR2Client({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    buckets: { private: env.R2_PRIVATE_BUCKET },
  });
  return defineUploads(r2, {
    attachment: {
      visibility: "private",
      prefix: "att",
      maxSize: "50MB",
      allowedTypes: ["image/*"],
      auth: ({ ctx }) => getUserId(ctx.req, env),
      rateLimit: async ({ owner }) => (await env.UPLOAD_LIMITER.limit({ key: owner })).success,
    },
  });
}
```

**Vercel / Node**: use [Upstash](https://github.com/upstash/ratelimit-js).

```ts
import { createR2Client, defineUploads } from "@hiplip/hatid/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { getSession } from "./auth";

const r2 = createR2Client({
  accountId: process.env.R2_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  buckets: { private: "myapp-private" },
});

const limiter = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(20, "1 m") });

export const uploads = defineUploads(r2, {
  attachment: {
    visibility: "private",
    prefix: "att",
    maxSize: "50MB",
    allowedTypes: ["image/*"],
    auth: async ({ ctx }) => (await getSession(ctx.req))?.userId ?? null,
    rateLimit: async ({ owner }) => {
      const { success, reset } = await limiter.limit(owner);
      return success || { retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
    },
  },
});
```

One caveat: `confirm` checks that the key exists in storage *before* it calls `auth` and `rateLimit` (that is what keeps a missing key and a foreign key indistinguishable). So probes of non-existent keys cost one R2 `HEAD` and never reach your `rateLimit`. Keep ordinary request-level rate limiting (for example per IP, at your CDN or middleware) in front of the upload endpoint as well.

## Cleanup

Abandoned uploads (a tab closed mid-upload, a failed confirm) leave objects in `pending/`. Clear them with `cleanupUnconfirmed`, ideally from a cron:

```ts
import { cleanupUnconfirmed, createR2Client } from "@hiplip/hatid/server";

type Env = { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; R2_PRIVATE_BUCKET: string };

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const r2 = createR2Client({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      buckets: { private: env.R2_PRIVATE_BUCKET },
    });
    // Free plan: 50 subrequests per invocation. On paid plans raise `limit` (e.g. 900).
    const result = await cleanupUnconfirmed(r2, { olderThan: "24h", receiptTtl: "7d", limit: 45 });
    console.log(JSON.stringify({ hatidCleanup: result })); // { deleted: { pending, receipts, multipart }, done }
  },
};
```

It deletes `pending/` objects older than `olderThan` (default `"24h"`), `receipts/` older than `receiptTtl` (default `"7d"`), and aborts stale multipart uploads. `limit` (default 500) caps R2 subrequests per call, and `done: false` means there is more to do on the next run. Pass `dryRun: true` to see what would go.

[`examples/cleanup-worker`](examples/cleanup-worker) is a ready-to-deploy Worker with an hourly cron trigger.

**Alternative or backstop:** R2 lifecycle rules on the private bucket do the same with zero code: expire `pending/` after 1 day and `receipts/` after 7 days, and abort incomplete multipart uploads after 1 day (see [R2 setup](#r2-setup)).

## Errors

Server and client share one `HatidError` (`code`, `status`, `retryable`, `retryAfter?`), exported from `@hiplip/hatid/server` and `@hiplip/hatid/react`, with an `isHatidError` guard.

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `CONFIG` | 500 | no | Misconfiguration (thrown at definition or startup where possible) |
| `INVALID_INPUT` | 400 | no | Malformed request, input schema failure, metadata over 1 KB, bad key |
| `FILE_TOO_LARGE` | 413 | no | Declared size over `maxSize`, or size 0 or less |
| `INVALID_TYPE` | 415 | no | Type not in `allowedTypes`, or has parameters |
| `UNAUTHORIZED` | 401 | no | `auth` returned `null` at issue time |
| `RATE_LIMITED` | 429 | yes | `rateLimit` rejected; `retryAfter` seconds if given |
| `CONFIRM_REJECTED` | 404 | no | Missing key, `auth` failed, owner mismatch or bad token (deliberately identical) |
| `UPLOAD_INVALID` | 422 | no | The upload failed size, type or metadata checks; the object was deleted |
| `HOOK_FAILED` | 500 | yes | `onConfirmed` threw; the final copy was removed |
| `STORAGE` | 502 | yes | R2 error |
| `INTERNAL` | 500 | no | Unexpected error (for example `auth` threw) |

Client-only codes, never sent by the server: `TOO_MANY_FILES` (more files than `maxFiles` in one batch), `NETWORK` (the request failed or the transport threw) and `CANCELED` (the user canceled).

On the wire an error is `{ "error": { "code", "message", "retryAfter"? } }`. `STORAGE`, `HOOK_FAILED` and `CONFIG` send the client a generic message; the real cause goes to `onError`.

## What hatid is not

- Not a service: no dashboard, no API keys, no accounts, no billing, no hosted version (yet).
- No image transforms or resizing.
- No resumable uploads across page reloads.
- No server-enforced batch limits (use `rateLimit`).
- `StorageBackend` (the interface `createR2Client` implements) is `@experimental` and may change before 1.0. `createR2Client` and the route API are the stable surface.

## Contributing and testing

```sh
pnpm install
pnpm typecheck
pnpm test              # unit tests against a fake R2 that verifies real SigV4 signatures
pnpm build
```

`pnpm test:integration` runs the backend contract suite against **real** R2 buckets. Use a sandbox or dev bucket only: it sweeps all of `pending/` and leaves `itest/` objects and receipts behind. It is skipped unless the `R2_*` environment variables are set (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_PRIVATE_BUCKET`).

Releases go through changesets and npm trusted publishing from GitHub Actions.

## License

MIT
