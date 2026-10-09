import { HatidError } from "./errors";

const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)?\s*$/i;
const SIZE_MULT: Record<string, number> = {
  b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4,
};

/** Parses "2MB" (1024-based) or a positive integer byte count. */
export function parseSize(value: number | string, field = "size"): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new HatidError("CONFIG", `${field} must be a positive integer number of bytes`);
  }
  const m = typeof value === "string" ? SIZE_RE.exec(value) : null;
  if (!m) throw new HatidError("CONFIG", `${field}: cannot parse size "${String(value)}"`);
  const bytes = Math.floor(Number(m[1]) * SIZE_MULT[(m[2] ?? "b").toLowerCase()]!);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new HatidError("CONFIG", `${field} must be greater than 0`);
  return bytes;
}

const DUR_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/;
const DUR_MULT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "10m" / "24h" / "7d" or milliseconds into milliseconds (≥ 0). */
export function parseDuration(value: number | string, field = "duration"): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    throw new HatidError("CONFIG", `${field} must be a non-negative number of milliseconds`);
  }
  const m = typeof value === "string" ? DUR_RE.exec(value) : null;
  if (!m) throw new HatidError("CONFIG", `${field}: cannot parse duration "${String(value)}"`);
  return Math.floor(Number(m[1]) * DUR_MULT[m[2]!]!);
}
