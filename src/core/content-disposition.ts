import { cleanDisplayName } from "./filename";

/** RFC 6266 header with an ASCII fallback and an RFC 5987 UTF-8 filename*. */
export function contentDisposition(name: string, inline = false): string {
  const clean = cleanDisplayName(name) ?? "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
