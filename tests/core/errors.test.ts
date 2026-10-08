import { describe, expect, it } from "vitest";
import { HatidError, fromWire, isHatidError, toHatidError } from "../../src/core/errors";
import { foreignHatidError } from "../support/foreign-error";

describe("HatidError", () => {
  it("maps codes to status and retryability", () => {
    const e = new HatidError("FILE_TOO_LARGE", "too big");
    expect(e).toBeInstanceOf(Error);
    expect([e.code, e.status, e.retryable]).toEqual(["FILE_TOO_LARGE", 413, false]);
    expect(new HatidError("RATE_LIMITED", "slow", { retryAfter: 5 }).toWire()).toEqual({ code: "RATE_LIMITED", message: "slow", retryAfter: 5 });
    expect(new HatidError("CONFIRM_REJECTED", "x").status).toBe(404);
    expect(new HatidError("STORAGE", "x").retryable).toBe(true);
  });

  it("hides internal messages on the wire for CONFIG, STORAGE, HOOK_FAILED and INTERNAL", () => {
    expect(new HatidError("CONFIG", "auth returned 42").toWire().message).toBe("Server misconfiguration.");
    expect(new HatidError("STORAGE", "R2 said secret thing").toWire().message).not.toContain("secret");
    expect(new HatidError("HOOK_FAILED", "db password wrong").toWire().message).not.toContain("password");
    expect(new HatidError("INTERNAL", "stack").toWire().message).toBe("Internal error.");
  });

  it("round-trips through the wire format", () => {
    const back = fromWire({ error: { code: "UPLOAD_INVALID", message: "bad" } }, 422);
    expect(isHatidError(back)).toBe(true);
    expect([back.code, back.message, back.retryable]).toEqual(["UPLOAD_INVALID", "bad", false]);
  });

  it("falls back for unknown bodies and wraps foreign errors", () => {
    expect(fromWire("nope", 503).code).toBe("STORAGE");
    expect(fromWire({ error: { code: "WHAT" } }, 400).code).toBe("INTERNAL");
    const wrapped = toHatidError(new TypeError("boom"));
    expect([wrapped.code, wrapped.message]).toEqual(["INTERNAL", "boom"]);
  });

  it("recognises a HatidError from another bundle's copy of the class by its brand", () => {
    const foreign = foreignHatidError("RATE_LIMITED");
    expect(isHatidError(foreign)).toBe(true);
    expect(foreign instanceof HatidError).toBe(true);
    expect(toHatidError(foreign)).toBe(foreign);
    expect(isHatidError(new Error("x"))).toBe(false);
    expect(isHatidError({ code: "RATE_LIMITED" })).toBe(false);
    expect(isHatidError(null)).toBe(false);
    expect(new Error("x") instanceof HatidError).toBe(false);
  });
});
