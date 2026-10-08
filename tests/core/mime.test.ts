import { describe, expect, it } from "vitest";
import { clientContentType, extensionFor, isAllowedType, normalizeContentType, validateAllowedTypes } from "../../src/core/mime";

describe("mime", () => {
  it("normalizes bare types and rejects parameters", () => {
    expect(normalizeContentType(" Image/PNG ")).toBe("image/png");
    expect(normalizeContentType("text/plain;charset=utf-8")).toBeNull();
    expect(normalizeContentType("")).toBeNull();
    expect(normalizeContentType("nonsense")).toBeNull();
    expect(normalizeContentType(42)).toBeNull();
  });
  it("matches exact types and wildcards", () => {
    const allowed = validateAllowedTypes(["image/*", "application/pdf"]);
    expect(isAllowedType("image/webp", allowed)).toBe(true);
    expect(isAllowedType("application/pdf", allowed)).toBe(true);
    expect(isAllowedType("application/pdfx", allowed)).toBe(false);
    expect(isAllowedType("imagex/png", allowed)).toBe(false);
  });
  it("validates allowedTypes at definition", () => {
    expect(() => validateAllowedTypes([])).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => validateAllowedTypes(["*/*"])).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(() => validateAllowedTypes(["image/png; q=1"])).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    expect(validateAllowedTypes(["Image/PNG"])).toEqual(["image/png"]);
  });
  it("derives extensions only from a fixed table", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("application/octet-stream")).toBeUndefined();
    expect(extensionFor("application/x-unknown")).toBeUndefined();
  });
  it("cleans browser-reported types on the client", () => {
    expect(clientContentType("text/plain;charset=UTF-8")).toBe("text/plain");
    expect(clientContentType("")).toBe("application/octet-stream");
    expect(clientContentType(undefined)).toBe("application/octet-stream");
    expect(clientContentType("IMAGE/PNG")).toBe("image/png");
  });
});
