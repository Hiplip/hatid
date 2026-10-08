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
});
