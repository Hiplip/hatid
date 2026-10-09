import { HatidError } from "./errors";
import type { Visibility } from "./types";

export const META_VERSION = "1";
export const MAX_META_BYTES = 1024;
export const META_KEYS = [
  "hatid-v", "hatid-route", "hatid-owner", "hatid-visibility", "hatid-size",
  "hatid-max-size", "hatid-type", "hatid-issued-at", "hatid-meta",
] as const;

export type SignedMeta = {
  route: string;
  owner: string;
  visibility: Visibility;
  size: number;
  maxSize: number;
  type: string;
  issuedAt: number;
  input: unknown;
  metadata: unknown;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export const encodeText = (s: string): string => bytesToBase64url(encoder.encode(s));

export function decodeText(value: string): string | null {
  const bytes = base64urlToBytes(value);
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function validateOwner(owner: unknown): string {
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 128) {
    throw new HatidError("CONFIG", "auth must return an owner id string of 1–128 characters");
  }
  return owner;
}

export function encodeSignedMeta(m: SignedMeta): Record<string, string> {
  let json: string;
  try {
    json = JSON.stringify({ input: m.input, metadata: m.metadata });
  } catch (cause) {
    throw new HatidError("INVALID_INPUT", "input and metadata must be JSON-serializable", { cause });
  }
  const app = encodeText(json);
  if (app.length > MAX_META_BYTES) {
    throw new HatidError("INVALID_INPUT",
      `input + metadata are ${app.length} bytes encoded; the limit is ${MAX_META_BYTES}. Store identifiers only.`);
  }
  return {
    "hatid-v": META_VERSION,
    "hatid-route": m.route,
    "hatid-owner": encodeText(m.owner),
    "hatid-visibility": m.visibility,
    "hatid-size": String(m.size),
    "hatid-max-size": String(m.maxSize),
    "hatid-type": m.type,
    "hatid-issued-at": String(m.issuedAt),
    "hatid-meta": app,
  };
}

const INT_RE = /^\d{1,16}$/;

/** null = owner/route unreadable (caller can't prove ownership). valid=false = owner readable but object is not as issued. */
export function decodeSignedMeta(raw: Record<string, string>): { meta: SignedMeta; valid: boolean } | null {
  const ownerRaw = raw["hatid-owner"];
  const route = raw["hatid-route"];
  const owner = ownerRaw === undefined ? null : decodeText(ownerRaw);
  if (owner === null || owner.length === 0 || route === undefined) return null;

  const vis = raw["hatid-visibility"];
  const sizeRaw = raw["hatid-size"] ?? "", maxRaw = raw["hatid-max-size"] ?? "", atRaw = raw["hatid-issued-at"] ?? "";
  const type = raw["hatid-type"] ?? "";
  let app: { input?: unknown; metadata?: unknown } = {};
  let appOk = false;
  const appText = raw["hatid-meta"] === undefined ? null : decodeText(raw["hatid-meta"]);
  if (appText !== null) {
    try {
      const parsed: unknown = JSON.parse(appText);
      if (typeof parsed === "object" && parsed !== null) { app = parsed as typeof app; appOk = true; }
    } catch { /* invalid */ }
  }
  const keys = Object.keys(raw);
  const exact = keys.length === META_KEYS.length && META_KEYS.every((k) => k in raw);
  const wellFormed = (vis === "public" || vis === "private") && INT_RE.test(sizeRaw) && INT_RE.test(maxRaw) && INT_RE.test(atRaw) && type.length > 0 && appOk;
  return {
    meta: {
      route, owner,
      visibility: vis === "public" ? "public" : "private",
      size: Number(sizeRaw), maxSize: Number(maxRaw), type, issuedAt: Number(atRaw),
      input: app.input, metadata: app.metadata,
    },
    valid: exact && wellFormed && raw["hatid-v"] === META_VERSION,
  };
}

export function toAmzMetaHeaders(meta: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k}`, v]));
}

export function fromAmzMetaHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-")) out[name.slice("x-amz-meta-".length)] = value;
  });
  return out;
}
