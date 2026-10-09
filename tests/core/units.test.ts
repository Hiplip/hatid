import { describe, expect, it } from "vitest";
import { parseDuration, parseSize } from "../../src/core/units";

describe("parseSize", () => {
  it("parses 1024-based units and numbers", () => {
    expect(parseSize("2MB")).toBe(2 * 1024 * 1024);
    expect(parseSize("2 mib")).toBe(2 * 1024 * 1024);
    expect(parseSize("1.5KB")).toBe(1536);
    expect(parseSize("500")).toBe(500);
    expect(parseSize(42)).toBe(42);
  });
  it("rejects bad sizes with CONFIG", () => {
    for (const bad of ["", "abc", "-1MB", "1XB", 0, -5, 1.5, Number.NaN]) {
      expect(() => parseSize(bad as never, "maxSize")).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    }
  });
});

describe("parseDuration", () => {
  it("parses units into milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration(0)).toBe(0);
  });
  it("rejects bad durations", () => {
    for (const bad of ["10", "1y", "-1s", -1, Number.POSITIVE_INFINITY]) {
      expect(() => parseDuration(bad as never)).toThrowError(expect.objectContaining({ code: "CONFIG" }));
    }
  });
});
