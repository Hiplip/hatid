// tests/react/end-to-end.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTransport } from "../../src/react/http-transport";
import { UploadQueue } from "../../src/react/queue";
import { createFetchHandler } from "../../src/server/fetch";
import { defineUploads } from "../../src/server/routes";
import { FakeXhr, createFakeXhr } from "../support/fake-xhr";
import { sameBytes } from "../support/bytes";
import { makeR2 } from "../support/r2";

afterEach(() => FakeXhr.reset());

describe("end to end", () => {
  it("uploads single and multipart files through the real server code into the fake R2", async () => {
    const { r2, fake } = makeR2();
    const onConfirmed = vi.fn();
    const uploads = defineUploads(r2, {
      doc: { visibility: "private", prefix: "docs", maxSize: "50MB", allowedTypes: ["application/octet-stream", "text/plain"],
        multipart: { threshold: "5MB", partSize: "5MB" }, auth: () => "alice", onConfirmed },
    });
    const handler = createFetchHandler(uploads);
    const transport = httpTransport<typeof uploads>("/api/upload", {
      fetch: (url, init) => handler(new Request(new URL(String(url), "https://app.test"), init)),
    });
    FakeXhr.script = (x) => {
      void fake.fetch(x.url, { method: x.method, headers: x.headers, body: x.body as Blob }).then((res) =>
        x.respond(res.status, { etag: res.headers.get("etag") ?? "" }));
    };
    const q = new UploadQueue({ transport, route: "doc", createXhr: createFakeXhr, sleep: async () => {} });
    const big = new Uint8Array(11 * 1024 * 1024).map((_, i) => i % 7);
    const results = await q.upload([new File(["hello"], "a.txt", { type: "text/plain" }), big]);
    expect(results.map((r) => r.status)).toEqual(["success", "success"]);
    expect(onConfirmed).toHaveBeenCalledTimes(2);
    const bigKey = results[1]!.file!.key;
    const stored = fake.object("priv-bucket", bigKey)!.body;
    expect(stored.byteLength).toBe(big.byteLength);
    expect(sameBytes(stored, big)).toBe(true);
    expect(fake.keys("priv-bucket").filter((k) => k.startsWith("pending/"))).toEqual([]);
  });
});
