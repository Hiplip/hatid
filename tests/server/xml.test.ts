import { describe, expect, it } from "vitest";
import { escapeXml, xmlBlocks, xmlText } from "../../src/server/r2/xml";

describe("xml", () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>a&amp;b</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
    <Contents><Key>c</Key></Contents><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>`;
  it("reads blocks and decoded text", () => {
    expect(xmlBlocks(xml, "Contents")).toHaveLength(2);
    expect(xmlText(xmlBlocks(xml, "Contents")[0]!, "Key")).toBe("a&b");
    expect(xmlText(xml, "NextContinuationToken")).toBe("tok");
    expect(xmlText(xml, "Missing")).toBeUndefined();
    expect(xmlText("<E>&#65;&#x42;&quot;</E>", "E")).toBe('AB"');
  });
  it("escapes", () => {
    expect(escapeXml(`<"a'&>`)).toBe("&lt;&quot;a&apos;&amp;&gt;");
  });
});
