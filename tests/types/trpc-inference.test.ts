import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useUpload } from "../../src/react/use-upload";
import { defineUploads } from "../../src/server/routes";
import { trpcTransport } from "../../src/trpc";
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

const m = { mutate: async (_input: unknown): Promise<unknown> => undefined };
const transport = trpcTransport<typeof uploads>({ issue: m, confirm: m, signParts: m, complete: m, abort: m });

// Type-only: never called. Checked by `pnpm typecheck`.
function typeChecks() {
  useUpload({ transport, route: "doc", input: { noteId: "n1" } });
  // @ts-expect-error unknown route
  useUpload({ transport, route: "nope" });
  // @ts-expect-error wrong input shape
  useUpload({ transport, route: "doc", input: { noteId: 123 } });
}

describe("trpcTransport type inference", () => {
  it("is checked by typecheck", () => {
    expect(typeof typeChecks).toBe("function");
  });
});
