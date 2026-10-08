import { describe, expect, it } from "vitest";
import {
  META_KEYS, decodeSignedMeta, decodeText, encodeSignedMeta, encodeText, fromAmzMetaHeaders, toAmzMetaHeaders, validateOwner,
  type SignedMeta,
} from "../../src/core/metadata";

const base: SignedMeta = {
  route: "attachment", owner: "user_1", visibility: "private", size: 10, maxSize: 100,
  type: "image/png", issuedAt: 1_700_000_000_000, input: { noteId: "n1" }, metadata: { plan: "pro" },
};

describe("signed metadata", () => {
  it("encodes exactly the agreed key set and round-trips", () => {
    const raw = encodeSignedMeta(base);
    expect(Object.keys(raw).sort()).toEqual([...META_KEYS].sort());
    expect(raw["hatid-v"]).toBe("1");
    const decoded = decodeSignedMeta(raw)!;
    expect(decoded.valid).toBe(true);
    expect(decoded.meta).toEqual(base);
  });

  it("round-trips non-ASCII owners and header-safe values", () => {
    const raw = encodeSignedMeta({ ...base, owner: "ユーザー" });
    for (const v of Object.values(raw)) expect(v).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeSignedMeta(raw)!.meta.owner).toBe("ユーザー");
  });

  it("rejects invalid owners with CONFIG", () => {
    for (const bad of ["", "x".repeat(129), 5, null]) {
      expect(() => validateOwner(bad)).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    }
    expect(validateOwner("x".repeat(128))).toHaveLength(128);
  });

  it("enforces the 1 KB cap on input + metadata", () => {
    expect(() => encodeSignedMeta({ ...base, input: { blob: "x".repeat(800) } })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: expect.stringContaining("1024") }),
    );
  });

  it("rejects non-serializable input", () => {
    expect(() => encodeSignedMeta({ ...base, input: { n: 1n } })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("marks extra keys, bad versions and malformed values as invalid", () => {
    const raw = encodeSignedMeta(base);
    expect(decodeSignedMeta({ ...raw, extra: "x" })!.valid).toBe(false);
    expect(decodeSignedMeta({ ...raw, "hatid-v": "2" })!.valid).toBe(false);
    expect(decodeSignedMeta({ ...raw, "hatid-size": "ten" })!.valid).toBe(false);
    expect(decodeSignedMeta({ ...raw, "hatid-visibility": "world" })!.valid).toBe(false);
  });

  it("returns null when the owner or route is unreadable", () => {
    const { ["hatid-owner"]: _o, ...noOwner } = encodeSignedMeta(base);
    expect(decodeSignedMeta(noOwner)).toBeNull();
    expect(decodeSignedMeta({ ...encodeSignedMeta(base), "hatid-owner": "!!!" })).toBeNull();
  });

  it("converts to and from x-amz-meta headers", () => {
    const h = toAmzMetaHeaders({ "hatid-v": "1" });
    expect(h).toEqual({ "x-amz-meta-hatid-v": "1" });
    expect(fromAmzMetaHeaders(new Headers({ "X-Amz-Meta-Hatid-V": "1", "content-type": "a/b" }))).toEqual({ "hatid-v": "1" });
  });

  it("base64url text helpers reject garbage", () => {
    expect(decodeText(encodeText("héllo"))).toBe("héllo");
    expect(decodeText("a")).toBeNull();
    expect(decodeText("@@")).toBeNull();
  });
});
