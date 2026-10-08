import { describe } from "vitest";
import { createR2Client } from "../../src/server/r2";
import { runBackendContract } from "../contract/backend-contract";

const env = process.env;
const ready = Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_PRIVATE_BUCKET);

describe.skipIf(!ready)("live R2 (hatid-sandbox)", () => {
  runBackendContract("R2", () => ({
    backend: createR2Client({
      accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      buckets: { private: env.R2_PRIVATE_BUCKET! },
    }),
    http: (url, init) => fetch(url, init),
    prefix: `itest/run-${Date.now()}`,
    live: true,
  }));
});
