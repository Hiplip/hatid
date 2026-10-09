import { afterEach, describe, expect, it, vi } from "vitest";
import { abortUpload, completeUpload, signUploadParts } from "../../src/server/low-level/multipart";
import { setup } from "../support/flow";

const MiB = 1024 * 1024;

async function start() {
  const t = setup();
  const issued = await t.issue({ size: 11 * MiB, maxSize: "1GB", contentType: "image/png", multipart: { threshold: "5MB", partSize: "5MB" } });
  if (issued.kind !== "multipart") throw new Error("expected multipart");
  return { t, issued };
}

afterEach(() => vi.useRealTimers());

describe("multipart helpers", () => {
  it("signs exact part sizes, completes and confirms", async () => {
    const { t, issued } = await start();
    const parts = await signUploadParts(t.r2, { ...issued, owner: "alice", partNumbers: [1, 2, 3] });
    const sizes = [5 * MiB, 5 * MiB, MiB];
    const etags = [];
    for (const [i, p] of parts.entries()) {
      const res = await t.fake.fetch(p.url, { method: "PUT", body: new Uint8Array(sizes[i]!) });
      expect(res.status).toBe(200);
      etags.push({ partNumber: p.partNumber, etag: res.headers.get("etag")! });
    }
    const result = await completeUpload(t.r2, { ...issued, owner: "alice", parts: etags, fileName: "pic.png" });
    expect(result.file).toMatchObject({ size: 11 * MiB, contentType: "image/png", visibility: "private" });
    expect(t.fake.object("priv-bucket", result.file.key)).toBeDefined();
  });

  it("rejects foreign owners, tampered or expired tokens, and mismatched ids", async () => {
    const { t, issued } = await start();
    const call = (o: Partial<Parameters<typeof signUploadParts>[1]>) =>
      signUploadParts(t.r2, { ...issued, owner: "alice", partNumbers: [1], ...o });
    await expect(call({ owner: "bob" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    await expect(call({ token: `${issued.token}x` })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    await expect(call({ uploadId: "other" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    await expect(call({ key: issued.key.replace("att", "att2") })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await expect(call({})).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
  });

  it("validates part numbers", async () => {
    const { t, issued } = await start();
    for (const partNumbers of [[], [0], [4], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      await expect(signUploadParts(t.r2, { ...issued, owner: "alice", partNumbers })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("validates the completed part list", async () => {
    const { t, issued } = await start();
    await expect(completeUpload(t.r2, { ...issued, owner: "alice", parts: [{ partNumber: 1, etag: '"a"' }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("aborts", async () => {
    const { t, issued } = await start();
    await abortUpload(t.r2, { ...issued, owner: "alice" });
    expect(t.fake.uploads.size).toBe(0);
  });
});
