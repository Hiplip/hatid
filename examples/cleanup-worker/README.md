# hatid-cleanup-worker

An hourly Cloudflare Workers cron that calls `cleanupUnconfirmed` from `@hiplip/hatid/server`. It deletes unconfirmed uploads in `pending/` older than 24 hours, receipts older than 7 days, and stale multipart uploads in the private bucket.

It also proves that `@hiplip/hatid/server` bundles for Workers with no Node built-ins.

Wrangler needs Node.js 22 or newer to run `check` and `deploy`. The deployed Worker itself runs on Cloudflare's runtime, not Node.

## Deploy

1. Create an R2 API token with **Object Read & Write** on the private bucket only. Nothing else is needed.
2. Set the secrets (never commit them):

   ```sh
   pnpm --filter hatid-cleanup-worker exec wrangler secret put R2_ACCOUNT_ID
   pnpm --filter hatid-cleanup-worker exec wrangler secret put R2_ACCESS_KEY_ID
   pnpm --filter hatid-cleanup-worker exec wrangler secret put R2_SECRET_ACCESS_KEY
   ```

3. **Change `R2_PRIVATE_BUCKET`** in `wrangler.toml` `[vars]` to your private bucket name. It ships as `hatid-sandbox` (the maintainers' test bucket), which is not yours.
4. Deploy:

   ```sh
   pnpm --filter hatid-cleanup-worker deploy
   ```

Check the bundle without deploying: `pnpm --filter hatid-cleanup-worker check`.

## Behaviour

- Each cron invocation runs **one** budgeted `cleanupUnconfirmed` pass; it does not loop until `done`.
- Each run is capped at `limit: 45` R2 subrequests, which fits the Workers free plan (50 per invocation). On a paid plan, raise `limit` in `src/index.ts` (e.g. 900).
- The result is logged as JSON. `done: false` is normal when a run hits the limit. The next hourly invocation picks up where the backlog is, so there is nothing to retry manually.

## Alternative: R2 lifecycle rules

You can drop this worker and let R2 clean up on its own. On the private bucket, add these lifecycle rules:

- Expire objects under `pending/` after 1 day.
- Expire objects under `receipts/` after 7 days.
- Abort incomplete multipart uploads after 1 day.

Lifecycle rules need no code or secrets, but R2 runs them on its own schedule and does not log what it removed. The worker lets you choose the schedule and reports its counts in the logs. Use one or the other, or both.
