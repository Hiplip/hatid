import { HatidError } from "./errors";

export const PENDING_PREFIX = "pending/";
export const RECEIPT_PREFIX = "receipts/";

const PREFIX_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TAIL = `(?:\\d{4}/\\d{2}/)?${UUID}(?:-[a-z0-9._-]{1,64})?(?:\\.[a-z0-9]{1,10})?`;
const ANY_PENDING = new RegExp(`^pending/[a-z0-9][a-z0-9_-]*(?:/[a-z0-9][a-z0-9_-]*)*/${TAIL}$`);
const MAX_KEY = 512;

export function validatePrefix(prefix: string): string {
  if (typeof prefix !== "string" || prefix.length > 128 || !PREFIX_RE.test(prefix)) {
    throw new HatidError("CONFIG", `Invalid prefix "${String(prefix)}": use lowercase segments [a-z0-9_-] separated by "/"`);
  }
  const first = prefix.split("/")[0];
  if (first === "pending" || first === "receipts") {
    // Final keys are `<prefix>/…`: these would land in hatid's own pending/ and receipts/ folders and be swept.
    throw new HatidError("CONFIG", `Invalid prefix "${prefix}": "pending" and "receipts" are reserved first segments`);
  }
  return prefix;
}

export function generatePendingKey(o: {
  prefix: string;
  datePrefix: boolean;
  extension?: string | undefined;
  nameSlug?: string | undefined;
  now?: Date;
}): string {
  const d = o.now ?? new Date();
  const date = o.datePrefix ? `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/` : "";
  const name = o.nameSlug ? `-${o.nameSlug}` : "";
  const ext = o.extension ? `.${o.extension}` : "";
  return `${PENDING_PREFIX}${o.prefix}/${date}${crypto.randomUUID()}${name}${ext}`;
}

/** True when `key` has the exact shape of an issued pending key (optionally for one prefix). */
export function isPendingKey(key: unknown, prefix?: string): key is string {
  if (typeof key !== "string" || key.length > MAX_KEY) return false;
  if (prefix === undefined) return ANY_PENDING.test(key);
  // prefix was validated by validatePrefix, so it contains no regex metacharacters
  return new RegExp(`^pending/${prefix}/${TAIL}$`).test(key);
}

export function finalKeyOf(pendingKey: string): string {
  return pendingKey.slice(PENDING_PREFIX.length);
}

export function receiptKeyOf(finalKey: string): string {
  return RECEIPT_PREFIX + finalKey;
}

export function assertFinalKey(key: unknown): asserts key is string {
  const ok =
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_KEY &&
    !key.startsWith(PENDING_PREFIX) &&
    !key.startsWith(RECEIPT_PREFIX) &&
    !key.startsWith("/") &&
    !key.split("/").some((s) => s === "" || s === "." || s === "..");
  if (!ok) throw new HatidError("INVALID_INPUT", "Invalid file key");
}
