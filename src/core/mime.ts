import { HatidError } from "./errors";

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const WILDCARD_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/\*$/;

/** Lowercased bare `type/subtype`, or null (parameters such as ";charset" are rejected). */
export function normalizeContentType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  return TYPE_RE.test(t) ? t : null;
}

export function validateAllowedTypes(list: readonly string[]): string[] {
  if (!Array.isArray(list) || list.length === 0) throw new HatidError("CONFIG", "allowedTypes must be a non-empty array");
  return list.map((entry) => {
    const t = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (t === "*/*") throw new HatidError("CONFIG", 'allowedTypes: "*/*" is not allowed; list types explicitly');
    if (!TYPE_RE.test(t) && !WILDCARD_RE.test(t)) throw new HatidError("CONFIG", `allowedTypes: invalid entry "${String(entry)}"`);
    return t;
  });
}

export function isAllowedType(type: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : a === type));
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
  "image/svg+xml": "svg", "image/heic": "heic", "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
  "text/markdown": "md", "application/json": "json", "application/zip": "zip", "video/mp4": "mp4",
  "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav",
  "audio/webm": "weba",
};

export function extensionFor(type: string): string | undefined {
  return EXT[type];
}

/** Browser-side: strip parameters, lowercase, default to application/octet-stream. */
export function clientContentType(raw: string | undefined): string {
  const bare = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return TYPE_RE.test(bare) ? bare : "application/octet-stream";
}
