// tests/react/xhr.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { xhrPut } from "../../src/react/xhr";
import { FakeXhr, createFakeXhr } from "../support/fake-xhr";

afterEach(() => FakeXhr.reset());
const body = new Blob([new Uint8Array(10)]);

describe("xhrPut", () => {
  it("PUTs with the signed headers (minus forbidden ones), reports progress and returns the ETag", async () => {
    const onProgress = vi.fn();
    const res = await xhrPut({ url: "https://r2/x", headers: { "content-type": "a/b", "x-amz-meta-hatid-v": "1", "content-length": "10", host: "h" },
      body, signal: new AbortController().signal, onProgress, createXhr: createFakeXhr });
    const x = FakeXhr.all[0]!;
    expect([x.method, x.url, x.body]).toEqual(["PUT", "https://r2/x", body]);
    expect(x.headers).toEqual({ "content-type": "a/b", "x-amz-meta-hatid-v": "1" });
    expect(onProgress).toHaveBeenLastCalledWith(10);
    expect(res.etag).toBe('"etag-1"');
  });

  it("maps HTTP and network failures to retryable NETWORK errors", async () => {
    FakeXhr.script = (x) => queueMicrotask(() => x.respond(403));
    await expect(xhrPut({ url: "u", headers: {}, body, signal: new AbortController().signal, onProgress: () => {}, createXhr: createFakeXhr }))
      .rejects.toMatchObject({ code: "NETWORK", retryable: true, message: expect.stringContaining("403") });
    FakeXhr.script = (x) => queueMicrotask(() => x.fail());
    await expect(xhrPut({ url: "u", headers: {}, body, signal: new AbortController().signal, onProgress: () => {}, createXhr: createFakeXhr }))
      .rejects.toMatchObject({ code: "NETWORK", message: expect.stringContaining("CORS") });
  });

  it("aborts via the signal", async () => {
    FakeXhr.script = () => {};
    const ac = new AbortController();
    const p = xhrPut({ url: "u", headers: {}, body, signal: ac.signal, onProgress: () => {}, createXhr: createFakeXhr });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELED" });
    ac.abort();
    await expect(xhrPut({ url: "u", headers: {}, body, signal: ac.signal, onProgress: () => {}, createXhr: createFakeXhr })).rejects.toMatchObject({ code: "CANCELED" });
    expect(FakeXhr.all).toHaveLength(1);
  });
});
