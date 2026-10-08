import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { RouteInput, RouteName } from "../../src/core/types";
import { defineUploads } from "../../src/server/routes";
import { makeR2 } from "../support/r2";

describe("type inference", () => {
  it("infers route names, inputs and ctx", () => {
    const { r2 } = makeR2();
    const uploads = defineUploads(r2, {
      attachment: {
        visibility: "private", prefix: "att", maxSize: "1MB", allowedTypes: ["text/plain"],
        input: z.object({ noteId: z.string() }),
        auth: ({ ctx, input }) => {
          expectTypeOf(input).toEqualTypeOf<{ noteId: string }>();
          expectTypeOf(ctx).toEqualTypeOf<{ req: Request }>();
          return "u";
        },
        onConfirmed: ({ input }) => { expectTypeOf(input).toEqualTypeOf<{ noteId: string }>(); },
      },
      avatar: {
        visibility: "public", prefix: "av", maxSize: "1MB", allowedTypes: ["image/*"],
        auth: ({ input }) => { expectTypeOf(input).toEqualTypeOf<undefined>(); return null; },
      },
    });
    expectTypeOf<RouteName<typeof uploads>>().toEqualTypeOf<"attachment" | "avatar">();
    expectTypeOf<RouteInput<typeof uploads, "attachment">>().toEqualTypeOf<{ noteId: string }>();

    const custom = defineUploads.withContext<{ userId: string | null }>()(r2, {
      doc: { visibility: "private", prefix: "d", maxSize: "1MB", allowedTypes: ["text/plain"], auth: ({ ctx }) => ctx.userId },
    });
    expectTypeOf<RouteName<typeof custom>>().toEqualTypeOf<"doc">();

    expect(() =>
      // @ts-expect-error auth is required
      defineUploads(r2, { x: { visibility: "private", prefix: "x", maxSize: 1, allowedTypes: ["a/b"] } }),
    ).toThrow();
  });
});
