import { describe, expect, it } from "vitest";
import { cleanupUnconfirmed } from "../../src/server/low-level/cleanup";
import { makeR2 } from "../support/r2";

const HOUR = 3_600_000;

function seed() {
  const env = makeR2();
  const old = Date.now() - 25 * HOUR;
  env.fake.putObject("priv-bucket", "pending/att/old1", { lastModified: old });
  env.fake.putObject("priv-bucket", "pending/att/old2", { lastModified: old });
  env.fake.putObject("priv-bucket", "pending/att/fresh", { lastModified: Date.now() });
  env.fake.putObject("priv-bucket", "receipts/att/r-old", { lastModified: Date.now() - 8 * 24 * HOUR });
  env.fake.putObject("priv-bucket", "receipts/att/r-new", { lastModified: Date.now() });
  env.fake.putObject("priv-bucket", "att/final", { lastModified: old });
  return env;
}

describe("cleanupUnconfirmed", () => {
  it("deletes stale pending objects, old receipts and stale multipart uploads only", async () => {
    const env = seed();
    const { uploadId } = await env.r2.createMultipart({ key: "pending/att/mp", contentType: "a/b", signedMetadata: {} });
    env.fake.uploads.get(uploadId)!.initiated = Date.now() - 25 * HOUR;
    const result = await cleanupUnconfirmed(env.r2, { olderThan: "24h", receiptTtl: "7d" });
    expect(result).toEqual({ deleted: { pending: 2, receipts: 1, multipart: 1 }, done: true });
    expect(env.fake.keys("priv-bucket")).toEqual(["att/final", "pending/att/fresh", "receipts/att/r-new"]);
    expect(env.fake.uploads.size).toBe(0);
  });

  it("respects the subrequest budget and resumes on the next run", async () => {
    const env = seed();
    const first = await cleanupUnconfirmed(env.r2, { limit: 2 });
    expect(first.done).toBe(false);
    expect(first.deleted.pending).toBe(1);
    const second = await cleanupUnconfirmed(env.r2, { limit: 100 });
    expect(second.done).toBe(true);
    expect(env.fake.keys("priv-bucket")).toEqual(["att/final", "pending/att/fresh", "receipts/att/r-new"]);
  });

  it("counts without deleting in dry-run mode", async () => {
    const env = seed();
    expect((await cleanupUnconfirmed(env.r2, { dryRun: true })).deleted).toEqual({ pending: 2, receipts: 1, multipart: 0 });
    expect(env.fake.keys("priv-bucket")).toHaveLength(6);
  });
});
