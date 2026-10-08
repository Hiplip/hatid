import { AwsClient, AwsV4Signer } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { FakeR2 } from "../support/fake-r2";

async function presignPut(fake: FakeR2, key: string, headers: Record<string, string>, expires = 600) {
  const u = new URL(`${fake.endpoint}/priv-bucket/${key}`);
  u.searchParams.set("X-Amz-Expires", String(expires));
  const s = new AwsV4Signer({ url: u.toString(), method: "PUT", headers: new Headers(headers), accessKeyId: fake.accessKeyId,
    secretAccessKey: fake.secretAccessKey, service: "s3", region: "auto", signQuery: true, allHeaders: true });
  return (await s.sign()).url.toString();
}
/** Status plus the S3-style error code and message from an XML error body. */
async function failure(res: Response) {
  const text = await res.text();
  return { status: res.status, code: /<Code>([^<]*)<\/Code>/.exec(text)?.[1], message: /<Message>([^<]*)<\/Message>/.exec(text)?.[1] };
}
const meta = { "content-type": "text/plain", "x-amz-meta-hatid-owner": "YQ" };
const objUrl = (fake: FakeR2, key = "k") => `${fake.endpoint}/priv-bucket/${key}`;
const clientFor = (fake: FakeR2, secretAccessKey = fake.secretAccessKey) =>
  new AwsClient({ accessKeyId: fake.accessKeyId, secretAccessKey, service: "s3", region: "auto" });

describe("FakeR2 presigned URLs", () => {
  it("accepts a correctly signed presigned PUT", async () => {
    const fake = new FakeR2();
    const res = await fake.fetch(await presignPut(fake, "k", meta), { method: "PUT", headers: meta, body: new Uint8Array(3) });
    expect(res.status).toBe(200);
    expect(fake.object("priv-bucket", "k")?.meta).toEqual({ "hatid-owner": "YQ" });
  });

  it("rejects an altered signed header with SignatureDoesNotMatch", async () => {
    const fake = new FakeR2();
    const url = await presignPut(fake, "k", meta);
    const res = await fake.fetch(url, { method: "PUT", headers: { ...meta, "x-amz-meta-hatid-owner": "Yg" }, body: "x" });
    expect(await failure(res)).toEqual({ status: 403, code: "SignatureDoesNotMatch", message: "SignatureDoesNotMatch" });
  });

  it("rejects an unsigned x-amz-* header with AccessDenied naming the header", async () => {
    const fake = new FakeR2();
    const url = await presignPut(fake, "k", meta);
    const res = await fake.fetch(url, { method: "PUT", headers: { ...meta, "x-amz-meta-extra": "1" }, body: "x" });
    expect(await failure(res)).toEqual({ status: 403, code: "AccessDenied", message: "Unsigned header x-amz-meta-extra" });
  });

  it("rejects a changed content-type with SignatureDoesNotMatch", async () => {
    const fake = new FakeR2();
    const url = await presignPut(fake, "k", meta);
    const res = await fake.fetch(url, { method: "PUT", headers: { ...meta, "content-type": "text/html" }, body: "x" });
    expect(await failure(res)).toEqual({ status: 403, code: "SignatureDoesNotMatch", message: "SignatureDoesNotMatch" });
  });

  it("rejects a body whose length differs from the signed Content-Length with SignatureDoesNotMatch", async () => {
    const fake = new FakeR2();
    const sized = await presignPut(fake, "k2", { ...meta, "content-length": "3" });
    const res = await fake.fetch(sized, { method: "PUT", headers: meta, body: new Uint8Array(4) });
    expect(await failure(res)).toEqual({ status: 403, code: "SignatureDoesNotMatch", message: "SignatureDoesNotMatch" });
    expect((await fake.fetch(sized, { method: "PUT", headers: meta, body: new Uint8Array(3) })).status).toBe(200);
  });

  it("rejects an expired presigned URL with 'Request has expired'", async () => {
    const fake = new FakeR2();
    const expiring = await presignPut(fake, "k3", meta, 1);
    await new Promise((r) => setTimeout(r, 2100));
    const res = await fake.fetch(expiring, { method: "PUT", headers: meta, body: "x" });
    expect(await failure(res)).toEqual({ status: 403, code: "AccessDenied", message: "Request has expired" });
  });
});

describe("FakeR2 header-authenticated requests", () => {
  it("rejects a request with no Authorization header with AccessDenied", async () => {
    const fake = new FakeR2();
    const res = await fake.fetch(objUrl(fake), { method: "HEAD" });
    expect(await failure(res)).toEqual({ status: 403, code: "AccessDenied", message: "AccessDenied" });
  });

  it("accepts AwsClient-signed HEAD, PUT and DELETE", async () => {
    const fake = new FakeR2();
    const aws = clientFor(fake);
    fake.putObject("priv-bucket", "k", { body: new Uint8Array(5), contentType: "text/plain" });

    const head = await fake.fetch(await aws.sign(objUrl(fake), { method: "HEAD", headers: { "accept-encoding": "identity" } }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("5");

    const put = await fake.fetch(await aws.sign(objUrl(fake, "p"), { method: "PUT", headers: meta, body: "hello" }));
    expect(put.status).toBe(200);
    expect(fake.object("priv-bucket", "p")?.meta).toEqual({ "hatid-owner": "YQ" });

    const del = await fake.fetch(await aws.sign(objUrl(fake, "p"), { method: "DELETE" }));
    expect(del.status).toBe(204);
    expect(fake.object("priv-bucket", "p")).toBeUndefined();
  });

  it("accepts AwsClient-signed GET, multipart initiate and copy with copy headers", async () => {
    const fake = new FakeR2();
    const aws = clientFor(fake);
    fake.putObject("priv-bucket", "src", { body: new TextEncoder().encode("abc"), contentType: "text/plain", meta: { "hatid-owner": "YQ" } });

    const get = await fake.fetch(await aws.sign(objUrl(fake, "src"), { method: "GET" }));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("abc");

    const init = await fake.fetch(await aws.sign(objUrl(fake, "mp") + "?uploads", { method: "POST", headers: meta }));
    expect(init.status).toBe(200);
    expect(await init.text()).toContain("<UploadId>");

    const copy = await fake.fetch(await aws.sign(objUrl(fake, "dst"), {
      method: "PUT",
      headers: { "x-amz-copy-source": "/priv-bucket/src", "x-amz-metadata-directive": "REPLACE", "content-type": "text/plain" },
    }));
    expect(copy.status).toBe(200);
    expect(fake.object("priv-bucket", "dst")?.meta).toEqual({});
  });

  it("rejects a tampered signed header with SignatureDoesNotMatch", async () => {
    const fake = new FakeR2();
    const signed = await clientFor(fake).sign(objUrl(fake), { method: "PUT", headers: meta, body: "abc" });
    const tampered = { ...Object.fromEntries(signed.headers), "x-amz-meta-hatid-owner": "Yg" };
    const res = await fake.fetch(objUrl(fake), { method: "PUT", headers: tampered, body: "abc" });
    expect(await failure(res)).toEqual({ status: 403, code: "SignatureDoesNotMatch", message: "SignatureDoesNotMatch" });
    expect(fake.object("priv-bucket", "k")).toBeUndefined();
  });

  it("rejects a request signed with the wrong secret with SignatureDoesNotMatch", async () => {
    const fake = new FakeR2();
    const signed = await clientFor(fake, "not-the-secret").sign(objUrl(fake), { method: "DELETE" });
    const res = await fake.fetch(signed);
    expect(await failure(res)).toEqual({ status: 403, code: "SignatureDoesNotMatch", message: "SignatureDoesNotMatch" });
  });

  it("rejects a body that does not match the signed x-amz-content-sha256 with XAmzContentSHA256Mismatch", async () => {
    const fake = new FakeR2();
    // aws4fetch defaults S3 header-signed requests to UNSIGNED-PAYLOAD, so pin the hash of "abc" explicitly.
    const sha256Abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const signed = await clientFor(fake).sign(objUrl(fake), { method: "PUT", headers: { "x-amz-content-sha256": sha256Abc }, body: "abc" });
    const res = await fake.fetch(objUrl(fake), { method: "PUT", headers: Object.fromEntries(signed.headers), body: "abd" });
    expect(await failure(res)).toEqual({ status: 403, code: "XAmzContentSHA256Mismatch", message: "XAmzContentSHA256Mismatch" });
  });
});

describe("FakeR2 compressible content", () => {
  it("omits Content-Length for text/plain unless Accept-Encoding: identity is sent", async () => {
    const fake = new FakeR2();
    const aws = clientFor(fake);
    fake.putObject("priv-bucket", "k", { body: new Uint8Array(5), contentType: "text/plain" });
    fake.putObject("priv-bucket", "bin", { body: new Uint8Array(5), contentType: "application/octet-stream" });
    const plain = await fake.fetch(await aws.sign(objUrl(fake), { method: "HEAD" }));
    expect(plain.headers.get("content-encoding")).toBe("gzip");
    expect(plain.headers.get("content-length")).toBeNull();
    const identity = await fake.fetch(await aws.sign(objUrl(fake), { method: "HEAD", headers: { "accept-encoding": "identity" } }));
    expect(identity.headers.get("content-length")).toBe("5");
    expect(identity.headers.get("content-encoding")).toBeNull();
    const bin = await fake.fetch(await aws.sign(objUrl(fake, "bin"), { method: "HEAD" }));
    expect(bin.headers.get("content-length")).toBe("5");
  });
});
