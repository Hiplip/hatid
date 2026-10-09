import { createFetchHandler, type HandlerArgs } from "../server/fetch";
import type { Uploads } from "../server/routes";

/** App Router route handler: `export const { POST } = createNextHandler(uploads);` (node or edge runtime). */
export function createNextHandler<TCtx>(uploads: Uploads<TCtx, any>, ...args: HandlerArgs<TCtx>): { POST: (req: Request) => Promise<Response> } {
  const handler = createFetchHandler(uploads, ...args);
  return { POST: (req) => handler(req) };
}
