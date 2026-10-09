// tests/react/http-transport.test.ts
import { describe, expect, it, vi } from "vitest";
import { httpTransport } from "../../src/react/http-transport";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("httpTransport", () => {
  it("POSTs JSON with the action and returns the body", async () => {
    const fetch = vi.fn(async () => ok({ kind: "single", key: "k" }));
    const t = httpTransport("/api/upload", { fetch, headers: () => ({ "x-csrf": "1" }) });
    expect(await t.issue({ route: "doc", input: { a: 1 }, size: 3, contentType: "text/plain" })).toEqual({ kind: "single", key: "k" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/upload");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("x-csrf")).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({ route: "doc", input: { a: 1 }, size: 3, contentType: "text/plain", action: "issue" });
  });

  it("turns wire errors into HatidError", async () => {
    const t = httpTransport("/u", { fetch: async () => ok({ error: { code: "RATE_LIMITED", message: "slow", retryAfter: 3 } }, 429) });
    await expect(t.confirm({ route: "doc", key: "k" })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfter: 3, retryable: true });
  });

  it("maps network failures and aborts", async () => {
    const t = httpTransport("/u", { fetch: async () => { throw new TypeError("offline"); } });
    await expect(t.abort({ route: "doc", key: "k", uploadId: "u", token: "t" })).rejects.toMatchObject({ code: "NETWORK" });
    const ac = new AbortController();
    ac.abort();
    const aborting = httpTransport("/u", { fetch: async (_u, init) => { if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError"); return ok({}); } });
    await expect(aborting.confirm({ route: "doc", key: "k" }, ac.signal)).rejects.toMatchObject({ code: "CANCELED" });
  });
});
