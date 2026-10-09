// Control characters, C1 controls and bidi overrides/isolates (filename spoofing).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Lone UTF-16 surrogates (not part of a valid pair): encodeURIComponent throws on them.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Untrusted, cosmetic display name: NFC, no control/bidi chars, no / or \, trimmed, ≤ 1024 code points. */
export function cleanDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(LONE_SURROGATE, "").normalize("NFC").replace(UNSAFE, "").replace(/[/\\]/g, "").trim();
  const capped = Array.from(cleaned).slice(0, 1024).join("");
  return capped.length > 0 ? capped : undefined;
}

/** Key-safe slug: [a-z0-9._-], ≤ 64 chars, no leading/trailing separators. */
export function slugForKey(value: string): string | undefined {
  const slug = value
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-*\.-*/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/g, "");
  return slug.length > 0 ? slug : undefined;
}
