import { describe } from "vitest";
import { createR2Client } from "../../src/server/r2";
import { runBackendContract, signedHead } from "../contract/backend-contract";

const env = process.env;
const ready = Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_PRIVATE_BUCKET);
const publicBucket = env.R2_PUBLIC_BUCKET || undefined;

describe.skipIf(!ready)("live R2 (hatid-sandbox)", () => {
  runBackendContract("R2", () => {
    const creds = { accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! };
    return {
      backend: createR2Client({
        ...creds,
        buckets: { private: env.R2_PRIVATE_BUCKET!, ...(publicBucket ? { public: publicBucket } : {}) },
        // publicBaseUrl only shapes `file.url`; nothing in the suite fetches it, so a placeholder is fine.
        ...(publicBucket ? { publicBaseUrl: env.R2_PUBLIC_BASE_URL || "https://example.invalid" } : {}),
      }),
      http: (url, init) => fetch(url, init),
      prefix: `itest/run-${Date.now()}`,
      live: true,
      // The public case runs only when R2_PUBLIC_BUCKET is set.
      public: publicBucket ? { rawHead: signedHead({ ...creds, bucket: publicBucket }) } : undefined,
    };
  });
});
