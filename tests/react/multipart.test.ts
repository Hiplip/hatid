// tests/react/multipart.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MultipartIssue } from "../../src/core/types";
import { uploadMultipart } from "../../src/react/multipart";
import type { Transport } from "../../src/react/types";
import { FakeXhr, createFakeXhr } from "../support/fake-xhr";

afterEach(() => FakeXhr.reset());

const issued: MultipartIssue = { kind: "multipart", key: "pending/k", uploadId: "u1", token: "t", partSize: 4, partCount: 3 };
const body = new Blob([new Uint8Array(10)]);
let signCount = 0;

function transport(): Transport & { [K in "signParts" | "complete" | "abort"]: ReturnType<typeof vi.fn> } {
  return {
    issue: vi.fn(), confirm: vi.fn(),
    signParts: vi.fn(async ({ partNumbers }: { partNumbers: number[] }) => ({
      parts: partNumbers.map((n) => ({ partNumber: n, url: `https://r2.test/p${n}?v=${++signCount}`, headers: {} })),
    })),
    complete: vi.fn(async () => ({ file: { key: "k", visibility: "private" as const, size: 10, contentType: "a/b" } })),
    abort: vi.fn(async () => ({ ok: true as const })),
  } as never;
}
const run = (t: Transport, extra: Partial<Parameters<typeof uploadMultipart>[0]> = {}) =>
  uploadMultipart({ transport: t, route: "doc", issued, body, fileName: "f", signal: new AbortController().signal,
    onProgress: () => {}, createXhr: createFakeXhr, sleep: async () => {}, ...extra });

describe("uploadMultipart", () => {
  it("uploads each slice, aggregates progress and completes with sorted ETags", async () => {
    const t = transport();
    const progress: number[] = [];
    const onPartsDone = vi.fn();
    const result = await run(t, { onProgress: (n) => progress.push(n), onPartsDone });
    expect(FakeXhr.all.map((x) => (x.body as Blob).size).sort()).toEqual([2, 4, 4]);
    expect(progress.at(-1)).toBe(10);
    const parts = [1, 2, 3].map((n) => ({ partNumber: n, etag: expect.stringMatching(/^"etag-\d"$/) }));
    expect(onPartsDone).toHaveBeenCalledWith(parts);
    expect(t.complete).toHaveBeenCalledWith({ route: "doc", key: "pending/k", uploadId: "u1", token: "t", parts, fileName: "f" }, expect.any(AbortSignal));
    expect(result.file.key).toBe("k");
  });

  it("re-signs and retries a part whose URL expired (403)", async () => {
    const t = transport();
    let failed = false;
    FakeXhr.script = (x) => queueMicrotask(() => {
      if (x.url.includes("/p2") && !failed) { failed = true; return x.respond(403); }
      x.respond(200, { etag: `"e-${x.url}"` });
    });
    await run(t);
    const p2 = FakeXhr.all.filter((x) => x.url.includes("/p2"));
    expect(p2).toHaveLength(2);
    expect(p2[0]!.url).not.toBe(p2[1]!.url);
    expect(t.complete).toHaveBeenCalled();
  });

  it("gives up after the retry budget", async () => {
    FakeXhr.script = (x) => queueMicrotask(() => x.respond(500));
    await expect(run(transport(), { retries: 2 })).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("fails fast with a CORS hint when the ETag is not exposed", async () => {
    FakeXhr.script = (x) => queueMicrotask(() => x.respond(200));
    await expect(run(transport())).rejects.toMatchObject({ code: "CONFIG", message: expect.stringContaining("ExposeHeaders") });
  });

  it("respects partConcurrency", async () => {
    let inFlight = 0, peak = 0;
    FakeXhr.script = (x) => { inFlight++; peak = Math.max(peak, inFlight); setTimeout(() => { inFlight--; x.respond(200, { etag: '"e"' }); }, 5); };
    await run(transport(), { partConcurrency: 2 });
    expect(peak).toBe(2);
  });

  it("stops on abort", async () => {
    FakeXhr.script = () => {};
    const ac = new AbortController();
    const p = run(transport(), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELED" });
  });
});
