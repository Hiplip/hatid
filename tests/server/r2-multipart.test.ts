// tests/server/r2-multipart.test.ts
import { describe, expect, it } from "vitest";
import { makeR2 } from "../support/r2";

const MiB = 1024 * 1024;
const meta = { "hatid-v": "1", "hatid-owner": "dTE" };

describe("promote", () => {
  it("copies private files within the private bucket keeping metadata", async () => {
    const { r2, fake } = makeR2();
    fake.putObject("priv-bucket", "pending/a/k", { body: new Uint8Array(3), contentType: "text/plain", meta });
    await r2.promote({ pendingKey: "pending/a/k", finalKey: "a/k", visibility: "private", contentType: "text/plain", size: 3, metadata: meta });
    expect(fake.object("priv-bucket", "a/k")).toMatchObject({ contentType: "text/plain", meta });
  });

  it("copies public files across buckets with REPLACE: no metadata, optional Cache-Control", async () => {
    const { r2, fake } = makeR2({ config: { publicCacheControl: "public, max-age=60" } });
    fake.putObject("priv-bucket", "pending/a/k", { body: new Uint8Array(3), contentType: "image/png", meta });
    await r2.promote({ pendingKey: "pending/a/k", finalKey: "a/k", visibility: "public", contentType: "image/png", size: 3, metadata: meta });
    expect(fake.object("pub-bucket", "a/k")).toMatchObject({ contentType: "image/png", meta: {}, cacheControl: "public, max-age=60" });
    expect(fake.object("priv-bucket", "a/k")).toBeUndefined();
  });

  it("surfaces a failed cross-bucket copy as STORAGE", async () => {
    const { r2, fake } = makeR2({ fake: { crossBucketCopy: false } });
    fake.putObject("priv-bucket", "pending/a/k", { body: new Uint8Array(3), contentType: "image/png", meta });
    await expect(r2.promote({ pendingKey: "pending/a/k", finalKey: "a/k", visibility: "public", contentType: "image/png", size: 3, metadata: meta }))
      .rejects.toMatchObject({ code: "STORAGE" });
  });

  it("uses a multipart copy above the CopyObject limit", async () => {
    const { r2, fake } = makeR2({ config: { copyObjectMax: 5 * MiB }, fake: { maxCopySize: 5 * MiB } });
    const body = new Uint8Array(6 * MiB).map((_, i) => i % 251);
    fake.putObject("priv-bucket", "pending/a/big", { body, contentType: "video/mp4", meta });
    await r2.promote({ pendingKey: "pending/a/big", finalKey: "a/big", visibility: "private", contentType: "video/mp4", size: body.byteLength, metadata: meta });
    const copied = fake.object("priv-bucket", "a/big")!;
    expect(copied.body).toEqual(body);
    expect(copied.meta).toEqual(meta);
    expect(copied.contentType).toBe("video/mp4");
    expect(fake.uploads.size).toBe(0);
  }, 120_000); // deep toEqual over a 6 MiB typed array takes ~50s in vitest; the copy itself takes ~0.1s
});

describe("multipart", () => {
  it("creates, signs size-locked parts, completes and lists", async () => {
    const { r2, fake } = makeR2();
    const { uploadId } = await r2.createMultipart({ key: "pending/a/m", contentType: "video/mp4", signedMetadata: meta });
    expect((await r2.listMultipart({ prefix: "pending/", limit: 100 })).uploads).toEqual([expect.objectContaining({ key: "pending/a/m", uploadId })]);
    const parts = await r2.signParts({ key: "pending/a/m", uploadId, parts: [{ partNumber: 1, size: 5 * MiB }, { partNumber: 2, size: 10 }], expiresIn: 60_000 });
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    expect((await fake.fetch(parts[1]!.url, { method: "PUT", body: new Uint8Array(11) })).status).toBe(403); // size-locked
    const etags = [];
    for (const [i, size] of [5 * MiB, 10].entries()) {
      const res = await fake.fetch(parts[i]!.url, { method: "PUT", body: new Uint8Array(size) });
      expect(res.status).toBe(200);
      etags.push({ partNumber: i + 1, etag: res.headers.get("etag")! });
    }
    await r2.completeMultipart({ key: "pending/a/m", uploadId, parts: etags });
    expect(fake.object("priv-bucket", "pending/a/m")).toMatchObject({ contentType: "video/mp4", meta });
    expect(fake.object("priv-bucket", "pending/a/m")!.body.byteLength).toBe(5 * MiB + 10);
  });

  it("aborts", async () => {
    const { r2, fake } = makeR2();
    const { uploadId } = await r2.createMultipart({ key: "pending/a/x", contentType: "a/b", signedMetadata: meta });
    await r2.abortMultipart({ key: "pending/a/x", uploadId });
    expect(fake.uploads.size).toBe(0);
  });

  it("fails completion with bad ETags as STORAGE", async () => {
    const { r2 } = makeR2();
    const { uploadId } = await r2.createMultipart({ key: "pending/a/y", contentType: "a/b", signedMetadata: meta });
    await expect(r2.completeMultipart({ key: "pending/a/y", uploadId, parts: [{ partNumber: 1, etag: '"nope"' }] })).rejects.toMatchObject({ code: "STORAGE" });
  });
});
