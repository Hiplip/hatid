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
const meta = { "content-type": "text/plain", "x-amz-meta-hatid-owner": "YQ" };

describe("FakeR2", () => {
  it("accepts a correctly signed presigned PUT", async () => {
    const fake = new FakeR2();
    const res = await fake.fetch(await presignPut(fake, "k", meta), { method: "PUT", headers: meta, body: new Uint8Array(3) });
    expect(res.status).toBe(200);
    expect(fake.object("priv-bucket", "k")?.meta).toEqual({ "hatid-owner": "YQ" });
  });
  it("rejects altered signed headers, unsigned x-amz headers, expiry and length mismatch", async () => {
    const fake = new FakeR2();
    const url = await presignPut(fake, "k", meta);
    expect((await fake.fetch(url, { method: "PUT", headers: { ...meta, "x-amz-meta-hatid-owner": "Yg" }, body: "x" })).status).toBe(403);
    expect((await fake.fetch(url, { method: "PUT", headers: { ...meta, "x-amz-meta-extra": "1" }, body: "x" })).status).toBe(403);
    expect((await fake.fetch(url, { method: "PUT", headers: { ...meta, "content-type": "text/html" }, body: "x" })).status).toBe(403);
    const sized = await presignPut(fake, "k2", { ...meta, "content-length": "3" });
    expect((await fake.fetch(sized, { method: "PUT", headers: meta, body: new Uint8Array(4) })).status).toBe(403);
    expect((await fake.fetch(sized, { method: "PUT", headers: meta, body: new Uint8Array(3) })).status).toBe(200);
    const expiring = await presignPut(fake, "k3", meta, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await fake.fetch(expiring, { method: "PUT", headers: meta, body: "x" })).status).toBe(403);
  });
  it("requires credentials for header-signed requests", async () => {
    const fake = new FakeR2();
    expect((await fake.fetch(`${fake.endpoint}/priv-bucket/k`, { method: "HEAD" })).status).toBe(403);
    const aws = new AwsClient({ accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, service: "s3", region: "auto" });
    expect((await fake.fetch(await aws.sign(`${fake.endpoint}/priv-bucket/k`, { method: "HEAD" }))).status).toBe(404);
  });
});
