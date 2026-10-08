import { HatidError } from "../core/errors";
import { runUploadAction } from "./protocol";
import type { Uploads } from "./routes";

export type FetchHandlerOptions<TCtx> = {
  /** Build the hook context from the request. Defaults to `{ req }`. */
  context?: (req: Request) => TCtx | Promise<TCtx>;
  /** Default 64 KB. */
  maxBodyBytes?: number;
};

export type HandlerArgs<TCtx> = { req: Request } extends TCtx
  ? [options?: FetchHandlerOptions<TCtx>]
  : [options: FetchHandlerOptions<TCtx> & { context: (req: Request) => TCtx | Promise<TCtx> }];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const fail = (status: number, message: string, headers?: Record<string, string>) =>
  json(status, { error: { code: "INVALID_INPUT", message } }, headers);

class BodyTooLarge extends Error {}

async function readCapped(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new BodyTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** A standard `(Request) => Response` handler for Workers, Next.js, Hono, Bun, Deno… */
export function createFetchHandler<TCtx>(uploads: Uploads<TCtx, any>, ...args: HandlerArgs<TCtx>): (req: Request) => Promise<Response> {
  const options = args[0] as FetchHandlerOptions<TCtx> | undefined;
  const max = options?.maxBodyBytes ?? 64 * 1024;
  return async (req) => {
    if (req.method !== "POST") return fail(405, "Method not allowed", { allow: "POST" });
    // JSON-only blocks simple cross-site form posts (they cannot send application/json without CORS preflight).
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return fail(415, "Content-Type must be application/json");
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(req, max));
    } catch (e) {
      return e instanceof BodyTooLarge ? fail(413, "Request body too large") : fail(400, "Invalid JSON body");
    }
    let ctx: TCtx;
    try {
      ctx = options?.context ? await options.context(req) : ({ req } as TCtx);
    } catch (cause) {
      const error = new HatidError("INTERNAL", "context() failed", { cause });
      try { uploads.options.onError?.({ error, route: undefined, action: undefined }); } catch { /* ignore */ }
      return json(500, { error: error.toWire() });
    }
    const outcome = await runUploadAction(uploads, ctx, body);
    if (outcome.ok) return json(200, outcome.data);
    const retry = outcome.error.retryAfter !== undefined ? { "retry-after": String(outcome.error.retryAfter) } : {};
    return json(outcome.status, { error: outcome.error }, retry);
  };
}
