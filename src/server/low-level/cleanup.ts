import { PENDING_PREFIX, RECEIPT_PREFIX } from "../../core/keys";
import { parseDuration } from "../../core/units";
import type { StorageBackend } from "../backend";

export type CleanupResult = { deleted: { pending: number; receipts: number; multipart: number }; done: boolean };

/**
 * Deletes unconfirmed uploads older than `olderThan` (by LastModified), receipts older than `receiptTtl`,
 * and aborts stale multipart uploads. `limit` caps R2 subrequests per call (Workers: 50 free / 1000 paid).
 */
export async function cleanupUnconfirmed(backend: StorageBackend, o: {
  olderThan?: number | string; receiptTtl?: number | string; limit?: number; dryRun?: boolean;
} = {}): Promise<CleanupResult> {
  const now = Date.now();
  const olderThan = parseDuration(o.olderThan ?? "24h", "olderThan");
  const receiptTtl = parseDuration(o.receiptTtl ?? "7d", "receiptTtl");
  const dryRun = o.dryRun ?? false;
  let budget = Math.max(1, o.limit ?? 500);
  const deleted = { pending: 0, receipts: 0, multipart: 0 };
  const spend = () => (budget > 0 ? (budget--, true) : false);

  async function sweep(prefix: string, cutoff: number, field: "pending" | "receipts"): Promise<boolean> {
    let cursor: string | undefined;
    do {
      if (!spend()) return false;
      const page = await backend.list({ bucket: "private", prefix, limit: 1000, cursor });
      for (const obj of page.objects) {
        if (obj.lastModified >= cutoff) continue;
        if (!dryRun) {
          if (!spend()) return false;
          await backend.deleteObject({ key: obj.key, bucket: "private" });
        }
        deleted[field]++;
      }
      cursor = page.cursor;
    } while (cursor);
    return true;
  }

  async function sweepMultipart(cutoff: number): Promise<boolean> {
    let cursor: string | undefined;
    do {
      if (!spend()) return false;
      const page = await backend.listMultipart({ prefix: PENDING_PREFIX, limit: 1000, cursor });
      for (const u of page.uploads) {
        if (u.initiated >= cutoff) continue;
        if (!dryRun) {
          if (!spend()) return false;
          await backend.abortMultipart({ key: u.key, uploadId: u.uploadId });
        }
        deleted.multipart++;
      }
      cursor = page.cursor;
    } while (cursor);
    return true;
  }

  const done = (await sweep(PENDING_PREFIX, now - olderThan, "pending"))
    && (await sweep(RECEIPT_PREFIX, now - receiptTtl, "receipts"))
    && (await sweepMultipart(now - olderThan));
  return { deleted, done };
}
