import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineUploads, routeAbort, routeComplete, routeConfirm, routeIssue, routeSignParts } from "../../src/server/routes";
import { makeR2 } from "../support/r2";

const MiB = 1024 * 1024;
const ctx = { req: new Request("https://app.test/api/upload") };

function make(route: Record<string, unknown> = {}, withPublic = true) {
  const env = makeR2({ withPublic });
  const auth = vi.fn((_: { ctx: unknown; input: unknown }): string | null | { owner: string; metadata?: unknown } => "alice");
  const onConfirmed = vi.fn();
  const uploads = defineUploads(env.r2, {
    attachment: {
      visibility: "private", prefix: "att", maxSize: "20MB", allowedTypes: ["text/plain"],
      input: z.object({ noteId: z.string().trim().min(1) }),
      multipart: { threshold: "5MB", partSize: "5MB" },
      auth, onConfirmed, ...route,
    },
  });
  return { ...env, uploads, auth, onConfirmed };
}

async function issueAndPut(t: ReturnType<typeof make>, input: unknown = { noteId: "n1" }) {
  const issued = await routeIssue(t.uploads, "attachment", ctx, { input, size: 3, contentType: "text/plain" });
  if (issued.kind !== "single") throw new Error("expected single");
  expect((await t.browserPut(issued.url, issued.headers, "abc")).status).toBe(200);
  return issued;
}

describe("defineUploads validation", () => {
  const r2 = makeR2({ withPublic: false }).r2;
  const ok = { visibility: "private", prefix: "a", maxSize: "1MB", allowedTypes: ["text/plain"], auth: () => "u" } as const;
  it.each([
    [{ x: { ...ok, auth: undefined } }, "auth is required"],
    [{ "bad name!": ok }, "names must match"],
    [{ x: { ...ok, visibility: "public" } }, "public"],
    [{ x: { ...ok, input: { notASchema: true } } }, "Standard Schema"],
    [{ x: { ...ok, maxSize: "6GB", multipart: false } }, "multipart"],
    [{ x: { ...ok, prefix: "Bad" } }, "prefix"],
  ])("rejects %j", (routes, message) => {
    expect(() => defineUploads(r2, routes as never)).toThrowError(expect.objectContaining({ code: "CONFIG", message: expect.stringContaining(message) }));
  });
});

describe("route issue", () => {
  it("validates input before auth and passes the parsed value", async () => {
    const t = make();
    await expect(routeIssue(t.uploads, "attachment", ctx, { input: { noteId: "" }, size: 3, contentType: "text/plain" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(t.auth).not.toHaveBeenCalled();
    await routeIssue(t.uploads, "attachment", ctx, { input: { noteId: "  n1 " }, size: 3, contentType: "text/plain" });
    expect(t.auth).toHaveBeenCalledWith({ ctx, input: { noteId: "n1" } });
  });

  it("returns UNAUTHORIZED when auth returns null", async () => {
    const t = make();
    t.auth.mockReturnValue(null);
    await expect(routeIssue(t.uploads, "attachment", ctx, { input: { noteId: "n" }, size: 3, contentType: "text/plain" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("applies rateLimit after auth with the owner and action", async () => {
    const rateLimit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce({ retryAfter: 7 }).mockResolvedValue(true);
    const t = make({ rateLimit });
    const body = { input: { noteId: "n" }, size: 3, contentType: "text/plain" };
    await expect(routeIssue(t.uploads, "attachment", ctx, body)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(routeIssue(t.uploads, "attachment", ctx, body)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfter: 7 });
    await expect(routeIssue(t.uploads, "attachment", ctx, body)).resolves.toMatchObject({ kind: "single" });
    expect(rateLimit).toHaveBeenCalledWith({ ctx, owner: "alice", action: "issue" });
  });

  it("rejects unknown routes", async () => {
    await expect(routeIssue(make().uploads, "nope", ctx, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("route confirm", () => {
  it("re-runs auth with the signed input and passes issue-time metadata to onConfirmed", async () => {
    const t = make();
    t.auth.mockReturnValueOnce({ owner: "alice", metadata: { at: "issue" } });
    const issued = await issueAndPut(t);
    t.auth.mockReturnValueOnce({ owner: "alice", metadata: { at: "confirm" } });
    const res = await routeConfirm(t.uploads, "attachment", ctx, { key: issued.key, fileName: "a.txt", input: { noteId: "forged" } });
    expect(res.file.key).toBe(issued.key.slice("pending/".length));
    expect(t.auth).toHaveBeenLastCalledWith({ ctx, input: { noteId: "n1" } });
    expect(t.onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ owner: "alice", input: { noteId: "n1" }, metadata: { at: "issue" }, fileName: "a.txt", ctx }));
  });

  it("revoked access between issue and confirm is rejected without deleting", async () => {
    const t = make();
    const issued = await issueAndPut(t);
    t.auth.mockReturnValueOnce(null);
    await expect(routeConfirm(t.uploads, "attachment", ctx, { key: issued.key })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
  });

  it("rate-limits confirm", async () => {
    const rateLimit = vi.fn(async ({ action }: { action: string }) => action !== "confirm");
    const t = make({ rateLimit });
    const issued = await issueAndPut(t);
    await expect(routeConfirm(t.uploads, "attachment", ctx, { key: issued.key })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not let one route confirm another route's upload", async () => {
    const env = makeR2();
    const base = { visibility: "private", prefix: "shared", maxSize: "1MB", allowedTypes: ["text/plain"], auth: () => "alice" } as const;
    const uploads = defineUploads(env.r2, { a: base, b: base });
    const issued = await routeIssue(uploads, "a", ctx, { size: 3, contentType: "text/plain" });
    if (issued.kind !== "single") throw new Error();
    await env.browserPut(issued.url, issued.headers, "abc");
    await expect(routeConfirm(uploads, "b", ctx, { key: issued.key })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
  });
});

describe("route multipart", () => {
  it("signs parts, completes (with onConfirmed) and refuses other users", async () => {
    const t = make();
    const issued = await routeIssue(t.uploads, "attachment", ctx, { input: { noteId: "n1" }, size: 6 * MiB, contentType: "text/plain" });
    if (issued.kind !== "multipart") throw new Error("expected multipart");
    const ids = { key: issued.key, uploadId: issued.uploadId, token: issued.token };
    t.auth.mockReturnValueOnce("bob");
    await expect(routeSignParts(t.uploads, "attachment", ctx, { ...ids, partNumbers: [1] })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    const { parts } = await routeSignParts(t.uploads, "attachment", ctx, { ...ids, partNumbers: [1, 2] });
    expect(t.auth).toHaveBeenLastCalledWith({ ctx, input: { noteId: "n1" } });
    const sizes = [5 * MiB, MiB];
    const etags = [];
    for (const [i, p] of parts.entries()) {
      const res = await t.fake.fetch(p.url, { method: "PUT", body: new Uint8Array(sizes[i]!) });
      etags.push({ partNumber: p.partNumber, etag: res.headers.get("etag")! });
    }
    const { file } = await routeComplete(t.uploads, "attachment", ctx, { ...ids, parts: etags, fileName: "big.txt" });
    expect(file.size).toBe(6 * MiB);
    expect(t.onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ fileName: "big.txt", input: { noteId: "n1" } }));
  });

  it("aborts", async () => {
    const t = make();
    const issued = await routeIssue(t.uploads, "attachment", ctx, { input: { noteId: "n1" }, size: 6 * MiB, contentType: "text/plain" });
    if (issued.kind !== "multipart") throw new Error();
    await expect(routeAbort(t.uploads, "attachment", ctx, { key: issued.key, uploadId: issued.uploadId, token: issued.token })).resolves.toEqual({ ok: true });
    expect(t.fake.uploads.size).toBe(0);
  });
});
