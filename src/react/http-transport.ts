import { fromWire, HatidError } from "../core/errors";
import type { Transport } from "./types";

export type HttpTransportOptions = {
  /** Extra headers (e.g. CSRF token). May be async. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
  /** Default "same-origin". */
  credentials?: RequestCredentials;
};

/** Transport for any `createFetchHandler` endpoint (Next.js, Workers, Hono…). Pass `typeof uploads` for typed routes. */
export function httpTransport<U = unknown>(url: string, options: HttpTransportOptions = {}): Transport<U> {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  async function call<T>(action: string, body: object, signal?: AbortSignal): Promise<T> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    const headers = new Headers(extra);
    headers.set("content-type", "application/json");
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST", headers, body: JSON.stringify({ ...body, action }),
        credentials: options.credentials ?? "same-origin", ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (signal?.aborted) throw new HatidError("CANCELED", "Upload canceled", { cause });
      throw new HatidError("NETWORK", "Could not reach the upload endpoint", { cause });
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw fromWire(json, res.status);
    return json as T;
  }
  return {
    issue: (req, signal) => call("issue", req, signal),
    confirm: (req, signal) => call("confirm", req, signal),
    signParts: (req, signal) => call("signParts", req, signal),
    complete: (req, signal) => call("complete", req, signal),
    abort: (req) => call("abort", req),
  };
}
