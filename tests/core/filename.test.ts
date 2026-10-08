import { describe, expect, it } from "vitest";
import { cleanDisplayName, slugForKey } from "../../src/core/filename";
import { contentDisposition } from "../../src/core/content-disposition";

describe("cleanDisplayName", () => {
  it("normalizes, strips control, bidi and path characters, and trims", () => {
    expect(cleanDisplayName("  a/b\\c\u0000.txt ")).toBe("abc.txt");
    expect(cleanDisplayName("evil‮txt.exe")).toBe("eviltxt.exe");
    expect(cleanDisplayName("é")).toBe("é");
  });
  it("keeps base64url ciphertext intact", () => {
    const ct = "q2Vf-Zx_9AbC0123456789-_";
    expect(cleanDisplayName(ct)).toBe(ct);
  });
  it("caps at 1024 code points without splitting surrogate pairs", () => {
    const long = "😀".repeat(2000);
    const out = cleanDisplayName(long)!;
    expect(Array.from(out)).toHaveLength(1024);
    expect(out.endsWith("😀")).toBe(true);
  });
  it("returns undefined for empty or non-strings", () => {
    expect(cleanDisplayName("   ")).toBeUndefined();
    expect(cleanDisplayName(undefined)).toBeUndefined();
    expect(cleanDisplayName(5)).toBeUndefined();
  });
});

describe("slugForKey", () => {
  it("produces a safe, short slug", () => {
    expect(slugForKey("My Résumé (final).PDF")).toBe("my-resume-final.pdf");
    expect(slugForKey("../../etc/passwd")).toBe("etc-passwd");
    expect(slugForKey("日本語")).toBeUndefined();
    expect(slugForKey("a".repeat(100))!.length).toBe(64);
  });
});

describe("contentDisposition", () => {
  it("adds an ASCII fallback and an RFC 5987 filename*", () => {
    expect(contentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition("日本.pdf", true)).toBe(`inline; filename="__.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf`);
    expect(contentDisposition(`a"b;c'(1)*.txt`)).toBe(`attachment; filename="a_b;c'(1)*.txt"; filename*=UTF-8''a%22b%3Bc%27%281%29%2A.txt`);
    expect(contentDisposition("😀.png")).toContain("filename*=UTF-8''%F0%9F%98%80.png");
    expect(contentDisposition("   ")).toContain(`filename="download"`);
  });
});
