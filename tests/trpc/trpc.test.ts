import { initTRPC } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { defineUploads } from "../../src/server/routes";
import { createUploadRouter, trpcTransport } from "../../src/trpc";
import { makeR2 } from "../support/r2";

type Ctx = { userId: string | null };

function make(userId: string | null) {
  const env = makeR2();
  const onError = vi.fn();
  const uploads = defineUploads.withContext<Ctx>()(env.r2, {
    doc: { visibility: "private", prefix: "d", maxSize: "1MB", allowedTypes: ["text/plain"], auth: ({ ctx }) => ctx.userId },
  }, { onError });
  const t = initTRPC.context<Ctx>().create();
  const appRouter = t.router({ upload: createUploadRouter({ t, procedure: t.procedure, uploads }) });
  const caller = t.createCallerFactory(appRouter)({ userId }) as any;
  const transport = trpcTransport<typeof uploads>({
    issue: { mutate: (i) => caller.upload.issue(i) },
    confirm: { mutate: (i) => caller.upload.confirm(i) },
    signParts: { mutate: (i) => caller.upload.signParts(i) },
    complete: { mutate: (i) => caller.upload.complete(i) },
    abort: { mutate: (i) => caller.upload.abort(i) },
  });
  return { ...env, transport, onError };
}

describe("tRPC adapter", () => {
  it("runs issue → upload → confirm through tRPC procedures", async () => {
    const t = make("alice");
    const issued = await t.transport.issue({ route: "doc", input: undefined, size: 3, contentType: "text/plain" });
    if (issued.kind !== "single") throw new Error();
    await t.browserPut(issued.url, issued.headers, "abc");
    const { file } = await t.transport.confirm({ route: "doc", key: issued.key });
    expect(file.key).toBe(issued.key.slice("pending/".length));
  });

  it("surfaces typed errors", async () => {
    const t = make(null);
    await expect(t.transport.issue({ route: "doc", input: undefined, size: 3, contentType: "text/plain" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("maps transport failures to NETWORK", async () => {
    const transport = trpcTransport({
      issue: { mutate: async () => { throw new Error("socket closed"); } },
      confirm: { mutate: vi.fn() }, signParts: { mutate: vi.fn() }, complete: { mutate: vi.fn() }, abort: { mutate: vi.fn() },
    });
    await expect(transport.issue({ route: "doc", input: undefined, size: 1, contentType: "text/plain" })).rejects.toMatchObject({ code: "NETWORK" });
  });

  const throwing = (thrown: unknown) => trpcTransport({
    issue: { mutate: async () => { throw thrown; } },
    confirm: { mutate: vi.fn() }, signParts: { mutate: vi.fn() }, complete: { mutate: vi.fn() }, abort: { mutate: vi.fn() },
  }).issue({ route: "doc", input: undefined, size: 1, contentType: "text/plain" });
  // TRPCClientError-shaped objects (duck-typed: hatid has no runtime @trpc import)
  const clientError = (httpStatus: number, code: string, where: "data" | "shape" = "data") =>
    Object.assign(new Error(code), { name: "TRPCClientError",
      ...(where === "data" ? { data: { code, httpStatus } } : { shape: { data: { code, httpStatus } } }) });

  it("maps a tRPC 401 (e.g. protectedProcedure) to non-retryable UNAUTHORIZED", async () => {
    for (const where of ["data", "shape"] as const) {
      await expect(throwing(clientError(401, "UNAUTHORIZED", where))).rejects.toMatchObject({ code: "UNAUTHORIZED", retryable: false });
    }
  });

  it("maps other tRPC 4xx to non-retryable INVALID_INPUT", async () => {
    for (const [status, code] of [[400, "BAD_REQUEST"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [413, "PAYLOAD_TOO_LARGE"]] as const) {
      await expect(throwing(clientError(status, code))).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
    }
  });

  it("keeps tRPC 429 retryable and 5xx / unknown failures as NETWORK", async () => {
    await expect(throwing(clientError(429, "TOO_MANY_REQUESTS"))).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await expect(throwing(clientError(408, "TIMEOUT"))).rejects.toMatchObject({ code: "NETWORK", retryable: true });
    await expect(throwing(clientError(500, "INTERNAL_SERVER_ERROR"))).rejects.toMatchObject({ code: "NETWORK", retryable: true });
    await expect(throwing({ data: { httpStatus: "401" } })).rejects.toMatchObject({ code: "NETWORK" });
    await expect(throwing(null)).rejects.toMatchObject({ code: "NETWORK" });
  });
});
