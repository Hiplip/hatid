# hatid follow-ups (after v0.1.0 is published)

## 1. Hiplip/saas-starter (Next.js, tRPC, Drizzle, Better Auth, Neon)

R2 setup: CORS is set once per bucket in the Cloudflare dashboard (see the hatid README for the exact JSON), and the app token needs only Object Read & Write.

1. `pnpm add @hiplip/hatid`. Env (`.env.example` + the env schema): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_PRIVATE_BUCKET`, optional `R2_PUBLIC_BUCKET` + `R2_PUBLIC_BASE_URL`.
2. Drizzle table `files`:
   `id uuid pk default random`, `key text not null unique`, `ownerId text not null references user(id) on delete cascade`,
   `size bigint not null`, `contentType text not null`, `visibility text not null`, `fileName text`, `createdAt timestamptz default now()`.
   Index on (`ownerId`, `createdAt`). Generate and run the migration.
3. `server/uploads.ts`: `createR2Client` from env, then `defineUploads.withContext<TRPCContext>()` with an `avatar` (public, image/*, 2MB)
   and an `attachment` (private) route. `auth: ({ ctx }) => ctx.session?.user.id ?? null`.
   `onConfirmed` → `db.insert(files).values(…).onConflictDoNothing({ target: files.key })`.
4. tRPC: `upload: createUploadRouter({ t, procedure: publicProcedure, uploads })` in the app router (auth lives in the routes).
   Add `files.list` (owner-scoped), `files.downloadUrl` (owner check, then `createDownloadUrl`), and `files.delete` (owner check, then `deleteFile` + row delete).
5. Client: `useUpload({ transport: trpcTransport<typeof uploads>(trpcClient.upload), route: "attachment" })` + `<Dropzone>` wrapped in shadcn/ui.
   `trpcTransport<typeof uploads>(trpcClient.upload)` works with the vanilla tRPC client without a cast (hatid 0.1.0 types the five procedures for this).
6. Rate limit with Upstash (`@upstash/ratelimit`), keyed by owner.
7. Cleanup: add an R2 lifecycle rule (no Workers in this template) and document `cleanupUnconfirmed` for a Vercel Cron route as an option.
8. Tests: owner scoping on list/download/delete; onConfirmed idempotency (double confirm → one row).

## 2. Hiplip/nimbus (end-to-end encrypted attachments)

R2 setup: CORS is set once per bucket in the Cloudflare dashboard (see the hatid README for the exact JSON), and the app token needs only Object Read & Write.

Constraint: nothing plaintext server-side. Ciphertext only; no file names in keys or metadata.

1. Route `attachment`: `visibility: "private"`, `prefix: "att"`, `datePrefix: false`, no `keyExtension`/`keyFileName`,
   `allowedTypes: ["application/octet-stream"]`, `maxSize` sized for ciphertext overhead (plaintext limit + AEAD tag/header).
2. `input: z.object({ noteId: z.string().uuid() })`. This is an identifier only, and `auth` checks the user can write to that note.
3. Client: encrypt with the note key (e.g. AES-GCM via WebCrypto), then `upload({ data: ciphertext, type: "application/octet-stream", fileName: encryptedNameB64url })`.
   The encrypted name must be base64url (survives hatid's display-name cleaning) and ≤ 1024 chars.
4. `onConfirmed` stores `{ key, noteId, size, encryptedName }` (size is ciphertext size). It never stores the plaintext name or type;
   the real MIME type goes inside the encrypted envelope.
5. Download: server checks note access, then `createDownloadUrl({ key, expiresIn: "1m" })` with no `downloadName`. The client fetches,
   decrypts, and builds a Blob with the decrypted name and type.
6. Deletion: deleting a note deletes its attachment rows, then `deleteFile` for each key (or a queue for large notes).
7. Threat-model notes: R2 sees ciphertext sizes and timing; `owner` and `noteId` sit in object metadata (identifiers, acceptable).
   Consider padding ciphertext to size buckets if size leakage matters.
