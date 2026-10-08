// tests/server/r2-client.test.ts
import { describe, expect, it } from "vitest";
import { encodeSignedMeta } from "../../src/core/metadata";
import { createR2Client } from "../../src/server/r2";
import { makeR2 } from "../support/r2";

const signed = encodeSignedMeta({ route: "", owner: "u1", visibility: "private", size: 3, maxSize: 10, type: "text/plain", issuedAt: 1, input: undefined, metadata: undefined });
const base = { accountId: "a", accessKeyId: "k", secretAccessKey: "s" };

describe("createR2Client config", () => {
  it.each([
    [{ ...base, buckets: {} }, "buckets.private"],
    [{ ...base, buckets: { private: "p-bucket", public: "q-bucket" } }, "publicBaseUrl"],
    [{ ...base, buckets: { private: "p-bucket", public: "p-bucket" }, publicBaseUrl: "https://x.com" }, "differ"],
    [{ ...base, buckets: { private: "p-bucket", public: "q-bucket" }, publicBaseUrl: "http://x.com" }, "https"],
    [{ ...base, buckets: { private: "Bad_Bucket" } }, "bucket name"],
    [{ ...base, accountId: "", buckets: { private: "p-bucket" } }, "accountId"],
  ])("rejects %j", (config, message) => {
    expect(() => createR2Client(config as never)).toThrowError(expect.objectContaining({ code: "CONFIG", message: expect.stringContaining(message) }));
  });
  it("reports capabilities", () => {
    expect(makeR2().r2.capabilities).toEqual({ publicBucket: true, publicBaseUrl: "https://files.example.com" });
    expect(makeR2({ withPublic: false }).r2.capabilities).toEqual({ publicBucket: false });
  });
});

describe("R2 objects", () => {
  it("issues a presigned PUT that the browser can use, and that rejects tampering", async () => {
    const { r2, fake, browserPut } = makeR2();
    const issued = await r2.issueUpload({ key: "pending/a/k", contentType: "text/plain", size: 3, signedMetadata: signed, expiresIn: 60_000 });
    expect(issued.method).toBe("PUT");
    expect(issued.headers["content-type"]).toBe("text/plain");
    expect(issued.headers["x-amz-meta-hatid-owner"]).toBe(signed["hatid-owner"]);
    expect(issued.headers["content-length"]).toBeUndefined(); // browsers set it themselves
    expect(new URL(issued.url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect((await browserPut(issued.url, { ...issued.headers, "x-amz-meta-hatid-owner": "eA" }, "abc")).status).toBe(403);
    expect((await browserPut(issued.url, issued.headers, "abcd")).status).toBe(403); // signed Content-Length
    expect((await browserPut(issued.url, issued.headers, "abc")).status).toBe(200);
    expect(fake.object("priv-bucket", "pending/a/k")?.meta["hatid-owner"]).toBe(signed["hatid-owner"]);
  });

  it("inspects pending, confirmed and missing keys", async () => {
    const { r2, fake } = makeR2();
    expect(await r2.inspect({ key: "pending/a/k" })).toEqual({ state: "missing" });
    fake.putObject("priv-bucket", "pending/a/k", { body: new Uint8Array(3), contentType: "text/plain", meta: signed });
    expect(await r2.inspect({ key: "pending/a/k" })).toEqual({ state: "pending", size: 3, contentType: "text/plain", metadata: signed });
    fake.buckets.get("priv-bucket")!.delete("pending/a/k");
    await r2.writeReceipt({ finalKey: "a/k", metadata: signed });
    expect(await r2.inspect({ key: "pending/a/k" })).toEqual({ state: "confirmed", metadata: signed });
  });

  it("heads, deletes (idempotently) and lists with pagination", async () => {
    const { r2, fake } = makeR2();
    for (const k of ["p/1", "p/2", "p/3", "q/1"]) fake.putObject("priv-bucket", k, { body: new Uint8Array(1) });
    expect(await r2.head({ key: "p/1", bucket: "private" })).toMatchObject({ size: 1 });
    expect(await r2.head({ key: "nope", bucket: "private" })).toBeNull();
    const first = await r2.list({ bucket: "private", prefix: "p/", limit: 2 });
    expect(first.objects.map((o) => o.key)).toEqual(["p/1", "p/2"]);
    const second = await r2.list({ bucket: "private", prefix: "p/", limit: 2, cursor: first.cursor });
    expect(second).toEqual({ objects: [expect.objectContaining({ key: "p/3" })] });
    await r2.deleteObject({ key: "p/1", bucket: "private" });
    await r2.deleteObject({ key: "p/1", bucket: "private" });
    expect(await r2.deleteObjects({ keys: ["p/2", "p/3"], bucket: "private" })).toEqual({ deleted: 2 });
    expect(fake.keys("priv-bucket")).toEqual(["q/1"]);
  });

  it("creates download URLs with Content-Disposition", async () => {
    const { r2, fake } = makeR2();
    fake.putObject("priv-bucket", "a/k", { body: new TextEncoder().encode("hi") });
    const url = await r2.createDownloadUrl({ key: "a/k", expiresIn: 300_000, contentDisposition: 'attachment; filename="x.txt"' });
    const res = await fake.fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="x.txt"');
  });

  it("maps R2 and network failures to STORAGE", async () => {
    const { r2, fake } = makeR2();
    fake.failNext = 1;
    await expect(r2.head({ key: "x", bucket: "private" })).rejects.toMatchObject({ code: "STORAGE" });
    const broken = createR2Client({ ...base, buckets: { private: "p-bucket" }, fetch: async () => { throw new TypeError("offline"); } });
    await expect(broken.inspect({ key: "pending/a/k" })).rejects.toMatchObject({ code: "STORAGE" });
  });
});

describe("tokens", () => {
  it("signs and verifies, rejecting tampering and other secrets", async () => {
    const { r2 } = makeR2();
    const token = await r2.signToken({ payload: { a: 1 } });
    expect(await r2.verifyToken({ token })).toEqual({ a: 1 });
    const [body, sig] = token.split(".");
    expect(await r2.verifyToken({ token: `${body}x.${sig}` })).toBeNull();
    expect(await r2.verifyToken({ token: "garbage" })).toBeNull();
    expect(await makeR2({ config: { secretAccessKey: "different" } }).r2.verifyToken({ token })).toBeNull();
    const custom = makeR2({ config: { tokenSecret: "t" } }).r2;
    expect(await custom.verifyToken({ token })).toBeNull();
    expect(await custom.verifyToken({ token: await custom.signToken({ payload: { b: 2 } }) })).toEqual({ b: 2 });
  });
});
