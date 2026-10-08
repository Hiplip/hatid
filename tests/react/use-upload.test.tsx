// tests/react/use-upload.test.tsx
// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { httpTransport } from "../../src/react/http-transport";
import type { Transport } from "../../src/react/types";
import { useUpload } from "../../src/react/use-upload";
import { defineUploads } from "../../src/server/routes";
import { FakeXhr, createFakeXhr } from "../support/fake-xhr";
import { makeR2 } from "../support/r2";

afterEach(() => FakeXhr.reset());

const transport = {
  issue: vi.fn(async () => ({ kind: "single" as const, key: "pending/k", url: "https://r2/k", method: "PUT" as const, headers: {} })),
  confirm: vi.fn(async () => ({ file: { key: "k", visibility: "private" as const, size: 3, contentType: "text/plain" } })),
  signParts: vi.fn(), complete: vi.fn(), abort: vi.fn(),
} as unknown as Transport;

describe("useUpload", () => {
  it("exposes queue state and actions", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useUpload({ transport, route: "doc", onComplete, createXhr: createFakeXhr } as never));
    expect(result.current.status).toBe("idle");
    await act(async () => { await result.current.upload(new File(["abc"], "a.txt", { type: "text/plain" })); });
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.items[0]).toMatchObject({ status: "success", fileName: "a.txt" });
    expect(onComplete).toHaveBeenCalledOnce();
    act(() => result.current.reset());
    expect(result.current.items).toEqual([]);
  });

  it("infers route names and inputs from the server's uploads", () => {
    const uploads = defineUploads(makeR2().r2, {
      note: { visibility: "private", prefix: "n", maxSize: "1MB", allowedTypes: ["text/plain"], input: z.object({ noteId: z.string() }), auth: () => "u" },
    });
    const typed = httpTransport<typeof uploads>("/api/upload");
    const check = () => {
      useUpload({ transport: typed, route: "note", input: { noteId: "x" } });
      // @ts-expect-error unknown route
      useUpload({ transport: typed, route: "nope" });
      // @ts-expect-error wrong input shape
      useUpload({ transport: typed, route: "note", input: { noteId: 1 } });
    };
    expectTypeOf(check).toBeFunction();
  });
});
