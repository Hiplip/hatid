const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith("#") ? String.fromCodePoint(parseInt(e.slice(1), 10))
      : ENTITIES[e]!);
}

/** Inner XML of every <tag>…</tag> (no nesting of the same tag in the S3 replies we read). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(re), (m) => m[1]!);
}

export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeXml(block.trim());
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
