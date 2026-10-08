import { createR2Client, defineUploads } from "@hiplip/hatid/server";
import { env } from "./env";
import { demoUserId } from "./session";
import { upsertFile } from "./store";

function build() {
  const r2 = createR2Client({
    accountId: env("R2_ACCOUNT_ID"),
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    buckets: process.env.R2_PUBLIC_BUCKET
      ? { private: env("R2_PRIVATE_BUCKET"), public: process.env.R2_PUBLIC_BUCKET }
      : { private: env("R2_PRIVATE_BUCKET") },
    ...(process.env.R2_PUBLIC_BASE_URL ? { publicBaseUrl: process.env.R2_PUBLIC_BASE_URL } : {}),
  });
  const uploads = defineUploads(r2, {
    document: {
      visibility: "private",
      prefix: "docs",
      maxSize: "5MB",
      allowedTypes: ["image/*", "application/pdf", "text/plain"],
      auth: ({ ctx }) => demoUserId(ctx.req),
      onConfirmed: async ({ file, owner, fileName }) => {
        await upsertFile({
          key: file.key, owner, size: file.size, contentType: file.contentType, fileName: fileName ?? null,
          visibility: file.visibility, url: file.url ?? null, createdAt: new Date().toISOString(),
        });
      },
    },
  });
  return { r2, uploads };
}

// Lazy so `next build` does not need R2 credentials.
let instance: ReturnType<typeof build> | undefined;
export const getHatid = () => (instance ??= build());
export type AppUploads = ReturnType<typeof build>["uploads"];
