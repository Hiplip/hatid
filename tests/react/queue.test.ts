// tests/react/queue.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { HatidError } from "../../src/core/errors";
import { UploadQueue, normalizeSource } from "../../src/react/queue";
import type { Transport } from "../../src/react/types";
import { FakeXhr, createFakeXhr } from "../support/fake-xhr";

afterEach(() => FakeXhr.reset());

const fileOf = (key: string, size = 3) => ({ key: key.replace("pending/", ""), visibility: "private" as const, size, contentType: "text/plain" });
let n = 0;
function transport(over: Partial<Record<keyof Transport, unknown>> = {}) {
  return {
    issue: vi.fn(async (r: { size: number }) => ({ kind: "single" as const, key: `pending/k${++n}`, url: `https://r2.test/${n}`, method: "PUT" as const, headers: { "content-type": "text/plain" }, size: r.size })),
    confirm: vi.fn(async (r: { key: string }) => ({ file: fileOf(r.key) })),
    signParts: vi.fn(), complete: vi.fn(), abort: vi.fn(async () => ({ ok: true as const })),
    ...over,
  } as unknown as Transport & Record<"issue" | "confirm" | "abort", ReturnType<typeof vi.fn>>;
}
const file = (name: string, size = 3, type = "text/plain") => new File([new Uint8Array(size)], name, { type });

describe("normalizeSource", () => {
  it("handles files, blobs, buffers and views", () => {
    expect(normalizeSource(file("a.txt", 3, "text/plain;charset=UTF-8"))).toMatchObject({ size: 3, type: "text/plain", fileName: "a.txt" });
    expect(normalizeSource(new Blob([new Uint8Array(4)]))).toMatchObject({ size: 4, type: "application/octet-stream", fileName: undefined });
    expect(normalizeSource(new ArrayBuffer(8))).toMatchObject({ size: 8, type: "application/octet-stream" });
    expect(normalizeSource(new Uint8Array(new ArrayBuffer(100), 10, 20))).toMatchObject({ size: 20 });
    expect(normalizeSource({ data: new Uint8Array(5), type: "Image/PNG", fileName: "x.png" })).toMatchObject({ size: 5, type: "image/png", fileName: "x.png" });
  });
});

describe("UploadQueue", () => {
  it("issues, uploads, confirms and reports results", async () => {
    const t = transport();
    const onComplete = vi.fn(), onAllComplete = vi.fn();
    const q = new UploadQueue({ transport: t, route: "doc", input: { noteId: "n" }, onComplete, onAllComplete, createXhr: createFakeXhr });
    const results = await q.upload(file("a.txt"));
    expect(t.issue).toHaveBeenCalledWith({ route: "doc", input: { noteId: "n" }, size: 3, contentType: "text/plain" }, expect.any(AbortSignal));
    expect(FakeXhr.all[0]!.headers["content-type"]).toBe("text/plain");
    expect(t.confirm).toHaveBeenCalledWith({ route: "doc", key: "pending/k1", fileName: "a.txt" }, expect.any(AbortSignal));
    expect(results).toEqual([expect.objectContaining({ status: "success", fileName: "a.txt", file: expect.objectContaining({ key: "k1" }) })]);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onAllComplete).toHaveBeenCalledWith(results);
    expect(q.getSnapshot()).toMatchObject({ status: "success", progress: 1 });
  });

  it("does not send file names at issue unless keyFileName is set", async () => {
    const t = transport();
    await new UploadQueue({ transport: t, route: "doc", keyFileName: true, createXhr: createFakeXhr }).upload(file("Cat.png", 3, "image/png"));
    expect(t.issue.mock.calls[0]![0]).toMatchObject({ fileName: "Cat.png" });
  });

  it("fails fast per item and keeps going", async () => {
    const t = transport();
    t.issue.mockImplementationOnce(async () => { throw new HatidError("FILE_TOO_LARGE", "big"); });
    const results = await new UploadQueue({ transport: t, route: "doc", createXhr: createFakeXhr }).upload([file("1"), file("2"), file("3")]);
    expect(results.map((r) => r.status)).toEqual(["error", "success", "success"]);
    expect(results[0]!.error).toMatchObject({ code: "FILE_TOO_LARGE", retryable: false });
  });

  it("enforces maxFiles client-side", async () => {
    const results = await new UploadQueue({ transport: transport(), route: "doc", maxFiles: 2, createXhr: createFakeXhr }).upload([file("1"), file("2"), file("3")]);
    expect(results.map((r) => r.status)).toEqual(["success", "success", "error"]);
    expect(results[2]!.error?.code).toBe("TOO_MANY_FILES");
  });

  it("retry re-confirms without re-uploading when only confirm failed", async () => {
    const t = transport();
    t.confirm.mockImplementationOnce(async () => { throw new HatidError("HOOK_FAILED", "db"); });
    const onAllComplete = vi.fn();
    const q = new UploadQueue({ transport: t, route: "doc", onAllComplete, createXhr: createFakeXhr });
    const [first] = await q.upload(file("a"));
    expect(first!.status).toBe("error");
    await q.retry(first!.id);
    expect(t.issue).toHaveBeenCalledOnce();
    expect(FakeXhr.all).toHaveLength(1);
    expect(t.confirm).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().items[0]!.status).toBe("success");
    expect(onAllComplete).toHaveBeenCalledTimes(2);
  });

  it("retry re-issues after an upload failure, and ignores non-retryable errors", async () => {
    const t = transport();
    FakeXhr.script = (x) => queueMicrotask(() => (FakeXhr.all.length === 1 ? x.fail() : x.respond(200, { etag: '"e"' })));
    const q = new UploadQueue({ transport: t, route: "doc", createXhr: createFakeXhr });
    const [r] = await q.upload(file("a"));
    await q.retry(r!.id);
    expect(t.issue).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().items[0]!.status).toBe("success");

    t.issue.mockImplementationOnce(async () => { throw new HatidError("INVALID_TYPE", "no"); });
    const [bad] = await q.upload(file("b"));
    await q.retry(bad!.id);
    expect(q.getSnapshot().items[1]!.status).toBe("error");
  });

  it("cancels in-flight and queued items", async () => {
    FakeXhr.script = () => {};
    const q = new UploadQueue({ transport: transport(), route: "doc", concurrency: 1, createXhr: createFakeXhr });
    const done = q.upload([file("a"), file("b")]);
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    q.cancel();
    const results = await done;
    expect(results.map((r) => r.status)).toEqual(["canceled", "canceled"]);
  });

  it("tracks bytes-weighted progress and notifies subscribers", async () => {
    let resolveXhr: (() => void) | undefined;
    FakeXhr.script = (x) => { x.progress(5, 10); resolveXhr = () => x.respond(200, { etag: '"e"' }); };
    const q = new UploadQueue({ transport: transport(), route: "doc", createXhr: createFakeXhr });
    const listener = vi.fn();
    q.subscribe(listener);
    const done = q.upload(file("a", 10));
    await vi.waitFor(() => expect(q.getSnapshot().progress).toBe(0.5));
    expect(q.getSnapshot().status).toBe("uploading");
    resolveXhr!();
    await done;
    expect(listener).toHaveBeenCalled();
    q.reset();
    expect(q.getSnapshot()).toMatchObject({ items: [], status: "idle", progress: 0 });
  });
});
