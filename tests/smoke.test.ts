import { describe, expect, it } from "vitest";
describe("toolchain", () => {
  it("runs on a runtime with WebCrypto and randomUUID", () => {
    expect(typeof crypto.subtle.sign).toBe("function");
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
