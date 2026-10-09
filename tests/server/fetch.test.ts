import { describe, expect, it, vi } from "vitest";
import { createNextHandler } from "../../src/next";
import { createFetchHandler } from "../../src/server/fetch";
import { defineUploads } from "../../src/server/routes";
import { decodeSignedMeta } from "../../src/core/metadata";
import { handleUploadAction, runUploadAction } from "../../src/server/protocol";
import { HatidError } from "../../src/core/errors";
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

  it("ignores a client-supplied owner and key at issue and confirm (rules 1, 4)", async () => {
    const onConfirmed = vi.fn();
    const t = make({ onConfirmed });
    const forged = "pending/docs/2026/01/00000000-0000-4000-8000-000000000000";
    const issued = await (await t.post({ action: "issue", route: "doc", size: 3, contentType: "text/plain", owner: "mallory", key: forged })).json();
    expect(issued.key).not.toBe(forged);
    expect(issued.key).toMatch(/^pending\/docs\//);
    await t.browserPut(issued.url, issued.headers, "abc");
    expect(decodeSignedMeta(t.fake.object("priv-bucket", issued.key)!.meta)?.meta.owner).toBe("alice");
    // mallory claiming alice's owner id in the body is still mallory
    const asMallory = await t.post({ action: "confirm", route: "doc", key: issued.key, owner: "alice" }, {
      headers: { "content-type": "application/json", cookie: "uid=mallory" },
    });
    expect([asMallory.status, (await asMallory.json()).error.code]).toEqual([404, "CONFIRM_REJECTED"]);
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
    const ok = await t.post({ action: "confirm", route: "doc", key: issued.key, owner: "mallory" });
    expect(ok.status).toBe(200);
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ owner: "alice" }));
  });

  it("handleUploadAction ignores a client-supplied owner (rule 4)", async () => {
    const t = make();
    const req = (uid: string) => ({ req: new Request("https://app.test", { headers: { cookie: `uid=${uid}` } }) });
    const issued = await handleUploadAction(t.uploads, req("alice"), { action: "issue", route: "doc", size: 3, contentType: "text/plain", owner: "mallory" }) as
      { key: string; url: string; headers: Record<string, string> };
    await t.browserPut(issued.url, issued.headers, "abc");
    expect(decodeSignedMeta(t.fake.object("priv-bucket", issued.key)!.meta)?.meta.owner).toBe("alice");
    await expect(handleUploadAction(t.uploads, req("mallory"), { action: "confirm", route: "doc", key: issued.key, owner: "alice" }))
      .rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    await expect(handleUploadAction(t.uploads, req("alice"), { action: "confirm", route: "doc", key: issued.key, owner: "mallory" }))
      .resolves.toMatchObject({ file: { key: issued.key.slice("pending/".length) } });
  });

  it("an async onError that rejects (or throws) never escapes and the response is unchanged", async () => {
    const env = makeR2();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const onError of [async () => { throw new Error("sentry down"); }, () => { throw new Error("sync logger bug"); }]) {
        const uploads = defineUploads(env.r2, {
          doc: { visibility: "private", prefix: "docs", maxSize: "1MB", allowedTypes: ["text/plain"], auth: () => "alice",
            onConfirmed: () => { throw new Error("db down"); } },
        }, { onError });
        const handler = createFetchHandler(uploads);
        const post = (body: unknown) => handler(new Request("https://app.test/api/upload", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
        const issued = await (await post({ action: "issue", route: "doc", size: 3, contentType: "text/plain" })).json();
        await env.browserPut(issued.url, issued.headers, "abc");
        const res = await post({ action: "confirm", route: "doc", key: issued.key });
        expect([res.status, (await res.json()).error.code]).toEqual([500, "HOOK_FAILED"]);
        const broken = createFetchHandler(uploads, { context: () => { throw new Error("no session store"); } });
        const ctxRes = await broken(new Request("https://app.test/api/upload", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
        expect([ctxRes.status, (await ctxRes.json()).error.code]).toEqual([500, "INTERNAL"]);
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a spread copy of a HatidError thrown from auth becomes a clean INTERNAL 500", async () => {
    const t = make({ auth: () => { throw { ...new HatidError("UNAUTHORIZED", "x") }; } });
    const outcome = await runUploadAction(t.uploads, { req: new Request("https://app.test") }, { action: "issue", route: "doc", size: 3, contentType: "text/plain" });
    expect(outcome).toEqual({ ok: false, status: 500, error: { code: "INTERNAL", message: "Internal error." } });
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
