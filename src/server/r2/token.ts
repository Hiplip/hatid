import { base64urlToBytes, bytesToBase64url, decodeText, encodeText } from "../../core/metadata";
import type { R2Context } from "./context";

const enc = new TextEncoder();

export function createTokenSigner(ctx: R2Context) {
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = () =>
    (keyPromise ??= (async () => {
      let raw: Uint8Array;
      if (ctx.tokenSecret) {
        raw = enc.encode(ctx.tokenSecret);
      } else {
        const base = await crypto.subtle.importKey("raw", enc.encode(ctx.secretAccessKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        raw = new Uint8Array(await crypto.subtle.sign("HMAC", base, enc.encode("hatid/multipart-token/v1")));
      }
      return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })());

  return {
    async sign(payload: Record<string, unknown>): Promise<string> {
      const body = encodeText(JSON.stringify(payload));
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), enc.encode(body)));
      return `${body}.${bytesToBase64url(sig)}`;
    },
    async verify(token: string): Promise<Record<string, unknown> | null> {
      if (typeof token !== "string" || token.length > 8192) return null;
      const dot = token.indexOf(".");
      if (dot <= 0) return null;
      const body = token.slice(0, dot);
      const sig = base64urlToBytes(token.slice(dot + 1));
      if (!sig || !(await crypto.subtle.verify("HMAC", await key(), sig as BufferSource, enc.encode(body)))) return null;
      const text = decodeText(body);
      if (text === null) return null;
      try {
        const value: unknown = JSON.parse(text);
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
  };
}
