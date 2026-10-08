import { describe, expect, it, vi } from "vitest";
import { createNextHandler } from "../../src/next";
import { createFetchHandler } from "../../src/server/fetch";
import { defineUploads } from "../../src/server/routes";
import { makeR2 } from "../support/r2";

const user = (req: Request) => /uid=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;

function make(extra: Record<string, unknown> = {}) {
  const env = makeR2();
  const onError = vi.fn();
  const uploads = defineUploads(env.r2, {
    doc: { visibility: "private", prefix: "docs", maxSize: "1MB", allowedTypes: ["text/plain"], auth: ({ ctx }) => user(ctx.req), ...extra },
  }, { onError });
  const handler = createFetchHandler(uploads);
  const post = (body: unknown, init: RequestInit = {}) => handler(new Request("https://app.test/api/upload", {
    method: "POST", headers: { "content-type": "application/json", cookie: "uid=alice" }, body: JSON.stringify(body), ...init,
  }));
  return { ...env, uploads, handler, post, onError };
}

describe("createFetchHandler", () => {
  it("runs issue → upload → confirm over HTTP", async () => {
    const t = make();
    const issueRes = await t.post({ action: "issue", route: "doc", size: 3, contentType: "text/plain" });
    expect(issueRes.status).toBe(200);
    expect(issueRes.headers.get("cache-control")).toBe("no-store");
    const issued = await issueRes.json();
    await t.browserPut(issued.url, issued.headers, "abc");
    const confirmRes = await t.post({ action: "confirm", route: "doc", key: issued.key, fileName: "a.txt" });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json()).file.key).toBe(issued.key.slice("pending/".length));
  });

  it("guards method, content type, size and JSON", async () => {
    const t = make();
    const get = await t.handler(new Request("https://app.test/api/upload"));
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    expect((await t.post({}, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await t.post("x".repeat(70_000))).status).toBe(413);
    expect((await t.post(undefined, { body: "{nope" })).status).toBe(400);
    const unknown = await t.post({ action: "issue", route: "nope" });
    expect([unknown.status, (await unknown.json()).error.code]).toEqual([400, "INVALID_INPUT"]);
    expect((await t.post({ action: "explode", route: "doc" })).status).toBe(400);
  });

  it("maps errors to status codes and wire bodies", async () => {
    const t = make();
    const anon = await t.post({ action: "issue", route: "doc", size: 3, contentType: "text/plain" }, { headers: { "content-type": "application/json" } });
    expect([anon.status, (await anon.json()).error.code]).toEqual([401, "UNAUTHORIZED"]);
    const big = await t.post({ action: "issue", route: "doc", size: 2 * 1024 * 1024, contentType: "text/plain" });
    expect(big.status).toBe(413);
  });

  it("sets Retry-After for rate limits", async () => {
    const t = make({ rateLimit: () => ({ retryAfter: 9 }) });
    const res = await t.post({ action: "issue", route: "doc", size: 3, contentType: "text/plain" });
    expect([res.status, res.headers.get("retry-after"), (await res.json()).error.retryAfter]).toEqual([429, "9", 9]);
  });

  it("hides storage errors from clients and reports them to onError", async () => {
    const t = make();
    const issued = await (await t.post({ action: "issue", route: "doc", size: 3, contentType: "text/plain" })).json();
    t.fake.failNext = 1;
    const res = await t.post({ action: "confirm", route: "doc", key: issued.key });
    const body = await res.json();
    expect([res.status, body.error.code, body.error.message]).toEqual([502, "STORAGE", "Storage request failed. Please retry."]);
    expect(t.onError).toHaveBeenCalledWith(expect.objectContaining({ route: "doc", action: "confirm", error: expect.objectContaining({ code: "STORAGE" }) }));
  });

  it("turns thrown hook errors into INTERNAL", async () => {
    const env = makeR2();
    const onError = vi.fn();
    const uploads = defineUploads(env.r2, {
      doc: { visibility: "private", prefix: "d", maxSize: "1MB", allowedTypes: ["text/plain"], auth: () => { throw new Error("session store down"); } },
    }, { onError });
    const res = await createFetchHandler(uploads)(new Request("https://app.test/u", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "issue", route: "doc", size: 1, contentType: "text/plain" }),
    }));
    const body = await res.json();
    expect([res.status, body.error.code, body.error.message]).toEqual([500, "INTERNAL", "Internal error."]);
    expect(onError).toHaveBeenCalled();
  });

  it("supports custom contexts", async () => {
    const env = makeR2();
    const uploads = defineUploads.withContext<{ userId: string | null }>()(env.r2, {
      doc: { visibility: "private", prefix: "d", maxSize: "1MB", allowedTypes: ["text/plain"], auth: ({ ctx }) => ctx.userId },
    });
    const handler = createFetchHandler(uploads, { context: (req) => ({ userId: req.headers.get("x-user") }) });
    const res = await handler(new Request("https://app.test/u", {
      method: "POST", headers: { "content-type": "application/json", "x-user": "carol" },
      body: JSON.stringify({ action: "issue", route: "doc", size: 1, contentType: "text/plain" }),
    }));
    expect(res.status).toBe(200);
  });

  it("exposes the same handler as a Next.js POST export", async () => {
    const t = make();
    const { POST } = createNextHandler(t.uploads);
    const res = await POST(new Request("https://app.test/api/upload", {
      method: "POST", headers: { "content-type": "application/json", cookie: "uid=alice" },
      body: JSON.stringify({ action: "issue", route: "doc", size: 3, contentType: "text/plain" }),
    }));
    expect(res.status).toBe(200);
  });
});
