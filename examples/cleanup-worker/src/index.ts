import { cleanupUnconfirmed, createR2Client } from "@hiplip/hatid/server";

type Env = { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; R2_PRIVATE_BUCKET: string };

export default {
  async scheduled(_controller, env) {
    const r2 = createR2Client({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      buckets: { private: env.R2_PRIVATE_BUCKET },
    });
    // Free plan: 50 subrequests per invocation. On paid plans raise `limit` (e.g. 900).
    const result = await cleanupUnconfirmed(r2, { olderThan: "24h", receiptTtl: "7d", limit: 45 });
    console.log(JSON.stringify({ hatidCleanup: result }));
  },
} satisfies ExportedHandler<Env>;
