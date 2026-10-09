import { HatidError, toHatidError, type WireError } from "../core/errors";
import { routeAbort, routeComplete, routeConfirm, routeIssue, routeSignParts, type AnyUploads } from "./routes";

const ACTIONS = { issue: routeIssue, confirm: routeConfirm, signParts: routeSignParts, complete: routeComplete, abort: routeAbort } as const;
type ActionName = keyof typeof ACTIONS;

/** Dispatches one protocol request. Throws HatidError (or whatever a hook threw). */
export async function handleUploadAction(uploads: AnyUploads, ctx: unknown, body: unknown): Promise<unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HatidError("INVALID_INPUT", "Request body must be a JSON object");
  const record = body as Record<string, unknown>;
  const { action, route } = record;
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) throw new HatidError("INVALID_INPUT", "Unknown action");
  if (typeof route !== "string") throw new HatidError("INVALID_INPUT", "Unknown upload route");
  return ACTIONS[action as ActionName](uploads, route, ctx, record);
}

export type ActionOutcome = { ok: true; data: unknown } | { ok: false; status: number; error: WireError };

/** Calls onError without ever letting it break the response: sync throws and async rejections are both swallowed. */
export function reportError(uploads: AnyUploads, e: { error: HatidError; route: string | undefined; action: string | undefined }): void {
  void Promise.resolve()
    .then(() => uploads.options.onError?.(e))
    .catch(() => { /* logging must never break the response */ });
}

const REPORTED = new Set(["CONFIG", "STORAGE", "HOOK_FAILED", "INTERNAL"]);

/** Like handleUploadAction, but never throws: returns a wire-safe outcome and reports server errors to onError. */
export async function runUploadAction(uploads: AnyUploads, ctx: unknown, body: unknown): Promise<ActionOutcome> {
  try {
    return { ok: true, data: await handleUploadAction(uploads, ctx, body) };
  } catch (e) {
    const error = toHatidError(e);
    if (REPORTED.has(error.code)) {
      const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      reportError(uploads, { error, route: typeof b.route === "string" ? b.route : undefined, action: typeof b.action === "string" ? b.action : undefined });
    }
    return { ok: false, status: error.status, error: error.toWire() };
  }
}
