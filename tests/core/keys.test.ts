import { describe, expect, it } from "vitest";
import { assertFinalKey, finalKeyOf, generatePendingKey, isPendingKey, receiptKeyOf, validatePrefix } from "../../src/core/keys";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe("keys", () => {
  it("validates prefixes", () => {
    expect(validatePrefix("avatars")).toBe("avatars");
    expect(validatePrefix("org_1/att-2")).toBe("org_1/att-2");
    for (const bad of ["", "/a", "a/", "a//b", "../a", "A", "a b", "a/../b", "x".repeat(129)]) {
      expect(() => validatePrefix(bad)).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    }
  });

  it("reserves pending and receipts as a first prefix segment", () => {
    for (const bad of ["pending", "receipts", "pending/x", "receipts/2026"]) {
      expect(() => validatePrefix(bad)).toThrowError(expect.objectContaining({ code: "CONFIG", message: expect.stringContaining("reserved") }));
    }
    for (const ok of ["pendings", "receipts-x", "my/receipts", "a/pending"]) expect(validatePrefix(ok)).toBe(ok);
  });

  it("generates date-prefixed keys by default", () => {
    const key = generatePendingKey({ prefix: "att", datePrefix: true, now: new Date(Date.UTC(2026, 0, 5)) });
    expect(key).toMatch(new RegExp(`^pending/att/2026/01/${UUID.source}$`));
    expect(isPendingKey(key, "att")).toBe(true);
  });

  it("supports flat keys, extensions and slugs", () => {
    expect(generatePendingKey({ prefix: "n", datePrefix: false })).toMatch(new RegExp(`^pending/n/${UUID.source}$`));
    const k = generatePendingKey({ prefix: "p", datePrefix: false, nameSlug: "cat-photo", extension: "jpg" });
    expect(k).toMatch(new RegExp(`^pending/p/${UUID.source}-cat-photo\\.jpg$`));
    expect(isPendingKey(k, "p")).toBe(true);
  });

  it("rejects keys that are not issued-key shaped or belong to another prefix", () => {
    const k = generatePendingKey({ prefix: "att", datePrefix: true });
    expect(isPendingKey(k, "avatars")).toBe(false);
    expect(isPendingKey(k)).toBe(true);
    for (const bad of ["att/x", "pending/att/../secret", "pending/att/not-a-uuid", "/pending/att/x", 42, "pending/att/" + "a".repeat(600)]) {
      expect(isPendingKey(bad)).toBe(false);
    }
  });

  it("derives final and receipt keys", () => {
    expect(finalKeyOf("pending/att/2026/01/u")).toBe("att/2026/01/u");
    expect(receiptKeyOf("att/2026/01/u")).toBe("receipts/att/2026/01/u");
  });

  it("guards final keys", () => {
    expect(() => assertFinalKey("att/2026/01/x")).not.toThrow();
    for (const bad of ["pending/a", "receipts/a", "", "/a", "a//b", "a/../b", "./a", 5]) {
      expect(() => assertFinalKey(bad)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});
