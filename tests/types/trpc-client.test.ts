import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useUpload } from "../../src/react/use-upload";
import { defineUploads } from "../../src/server/routes";
import { createUploadRouter, trpcTransport } from "../../src/trpc";
import { makeR2 } from "../support/r2";

type Ctx = { userId: string | null };

const { r2 } = makeR2();
const uploads = defineUploads.withContext<Ctx>()(r2, {
  doc: {
    visibility: "private", prefix: "d", maxSize: "1MB", allowedTypes: ["text/plain"],
    input: z.object({ noteId: z.string() }),
    auth: ({ ctx }) => ctx.userId,
  },
});

const t = initTRPC.context<Ctx>().create();
const appRouter = t.router({ upload: createUploadRouter({ t, procedure: t.procedure, uploads }) });
type AppRouter = typeof appRouter;

// Type-only: never called. Checked by `pnpm typecheck`. A real vanilla client, no cast.
function typeChecks() {
  const trpcClient = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "http://localhost/trpc" })] });
  const transport = trpcTransport<typeof uploads>(trpcClient.upload);
  useUpload({ transport, route: "doc", input: { noteId: "n1" } });
  // @ts-expect-error unknown route
  useUpload({ transport, route: "nope" });
  // @ts-expect-error wrong input shape
  useUpload({ transport, route: "doc", input: { noteId: 123 } });
}

describe("trpcTransport with a real tRPC client", () => {
  it("is checked by typecheck", () => {
    expect(typeof typeChecks).toBe("function");
    expect(appRouter).toBeDefined();
  });
});
