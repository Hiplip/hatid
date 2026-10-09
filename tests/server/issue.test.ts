// tests/server/issue.test.ts
import { describe, expect, it } from "vitest";
import { decodeSignedMeta } from "../../src/core/metadata";
import { planParts, resolveMultipart } from "../../src/server/low-level/issue";
import { setup } from "../support/flow";

const MiB = 1024 * 1024;

describe("createUploadUrl", () => {
  it("issues a single upload with a server-generated key and signed metadata", async () => {
    const t = setup();
    const issued = await t.issue({ route: "attachment", input: { noteId: "n1" }, metadata: { plan: "pro" } });
    expect(issued.kind).toBe("single");
    expect(issued.key).toMatch(/^pending\/att\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    if (issued.kind !== "single") return;
    const decoded = decodeSignedMeta(t.metaOf(issued.headers))!;
    expect(decoded.valid).toBe(true);
    expect(decoded.meta).toMatchObject({ route: "attachment", owner: "alice", visibility: "private", size: 3, maxSize: MiB,
      type: "text/plain", input: { noteId: "n1" }, metadata: { plan: "pro" } });
  });

  it.each([
    [{ size: 0 }, "FILE_TOO_LARGE"],
    [{ size: 2 * MiB }, "FILE_TOO_LARGE"],
    [{ size: 1.5 }, "INVALID_INPUT"],
    [{ contentType: "application/pdf" }, "INVALID_TYPE"],
    [{ contentType: "text/plain;charset=utf-8" }, "INVALID_TYPE"],
    [{ owner: "" }, "CONFIG"],
    [{ prefix: "../x" }, "CONFIG"],
    [{ input: { big: "x".repeat(900) } }, "INVALID_INPUT"],
  ])("rejects %j with %s", async (overrides, code) => {
    await expect(setup().issue(overrides as never)).rejects.toMatchObject({ code });
  });

  it("requires a public bucket for public uploads", async () => {
    await expect(setup({ withPublic: false }).issue({ visibility: "public" })).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("supports flat keys, extensions and opt-in name slugs", async () => {
    const t = setup();
    expect((await t.issue({ datePrefix: false })).key).toMatch(/^pending\/att\/[0-9a-f-]{36}$/);
    expect((await t.issue({ contentType: "image/png", keyExtension: true })).key).toMatch(/\.png$/);
    expect((await t.issue({ keyFileName: true, fileName: "Cat Photo.PNG", contentType: "image/png" })).key).toMatch(/-cat-photo\.png$/);
    expect((await t.issue({ fileName: "secret.txt" })).key).not.toContain("secret");
  });

  it("switches to multipart above the threshold", async () => {
    const t = setup();
    const issued = await t.issue({ size: 12 * MiB, maxSize: "1GB", multipart: { threshold: "10MB", partSize: "5MB" } });
    expect(issued).toMatchObject({ kind: "multipart", partSize: 5 * MiB, partCount: 3 });
    if (issued.kind !== "multipart") return;
    const payload = await t.r2.verifyToken({ token: issued.token });
    expect(payload).toMatchObject({ key: issued.key, uploadId: issued.uploadId, owner: "alice", size: 12 * MiB, partSize: 5 * MiB });
    expect(t.fake.uploads.size).toBe(1);
  });

  it("rejects files over the single-PUT limit when multipart is disabled", async () => {
    await expect(setup().issue({ size: 6 * 1024 ** 3, maxSize: "10GB", multipart: false })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

describe("multipart planning", () => {
  it("keeps parts ≥ 5 MiB and ≤ 10,000 parts", () => {
    expect(planParts(12 * MiB, 5 * MiB)).toEqual({ partSize: 5 * MiB, partCount: 3 });
    const huge = planParts(200 * 1024 ** 3, 10 * MiB);
    expect(huge.partCount).toBeLessThanOrEqual(10_000);
    expect(huge.partSize % MiB).toBe(0);
  });
  it("validates options", () => {
    expect(resolveMultipart(false)).toBeNull();
    expect(resolveMultipart(undefined)).toEqual({ threshold: 100 * MiB, partSize: 10 * MiB, tokenTtl: 86_400_000 });
    expect(() => resolveMultipart({ partSize: "1MB" })).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => resolveMultipart({ threshold: "6GB" })).toThrowError(expect.objectContaining({ code: "CONFIG" }));
  });
});
