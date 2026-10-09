import { fromWire, HatidError } from "../core/errors";
import type { Transport } from "../react/types";
import { runUploadAction, type ActionOutcome } from "../server/protocol";
import type { AnyUploads, Uploads } from "../server/routes";

// Structural shapes so hatid needs no runtime (or type) import of @trpc/server.
// `TProc` captures the concrete mutation procedure type your `procedure` builds.
type ProcedureLike<TProc> = {
  input: (parser: (value: unknown) => unknown) => { mutation: (resolver: (opts: any) => Promise<unknown>) => TProc };
};
type UploadProcedures<TProc> = { issue: TProc; confirm: TProc; signParts: TProc; complete: TProc; abort: TProc };
type RouterFactory = { router: (procedures: any) => unknown };

export type { ActionOutcome };

/**
 * Five tRPC mutations (issue, confirm, signParts, complete, abort) backed by `uploads`.
 * Hook `ctx` is your tRPC context: define routes with `defineUploads.withContext<Context>()`.
 * `auth` stays required on every route even when `procedure` is already protected.
 *
 * The return type keeps the five procedure keys (typed structurally, no @trpc/server type
 * dependency), so a real client's `trpcClient.upload` is accepted by `trpcTransport` without a
 * cast. The procedures take untyped input; route names and inputs are type-checked on the client
 * via `trpcTransport<typeof uploads>(trpcClient.upload)` together with `useUpload`.
 */
export function createUploadRouter<TProc, TCtx>(opts: {
  t: RouterFactory; procedure: ProcedureLike<TProc>; uploads: Uploads<TCtx, any>;
}): UploadProcedures<TProc> {
  const mutation = (action: string) =>
    opts.procedure
      .input((value: unknown) => value)
      .mutation(({ ctx, input }: { ctx: unknown; input: unknown }) =>
        runUploadAction(opts.uploads as AnyUploads, ctx, { ...(typeof input === "object" && input !== null ? input : {}), action }));
  const procedures: UploadProcedures<TProc> = {
    issue: mutation("issue"), confirm: mutation("confirm"), signParts: mutation("signParts"),
    complete: mutation("complete"), abort: mutation("abort"),
  };
  // A tRPC v11 router is `Router & TRecord`, so the five procedures are own properties of the
  // returned router: typing it as that record keeps the keys (and is how tRPC nests it either way).
  return opts.t.router(procedures) as UploadProcedures<TProc>;
}

type Mutation = { mutate: (input: any, opts?: { signal?: AbortSignal }) => Promise<unknown> };
export type TrpcUploadClient = { issue: Mutation; confirm: Mutation; signParts: Mutation; complete: Mutation; abort: Mutation };

const httpStatusOf = (e: unknown): number | undefined => {
  const o = e as { data?: { httpStatus?: unknown }; shape?: { data?: { httpStatus?: unknown } } } | null | undefined;
  const status = o?.data?.httpStatus ?? o?.shape?.data?.httpStatus;
  return typeof status === "number" ? status : undefined;
};

/**
 * A thrown tRPC client error (duck-typed, no @trpc import). HTTP 4xx answers, e.g. a protectedProcedure's
 * UNAUTHORIZED, can never succeed on retry, so they are non-retryable; 429 stays retryable; 408, 499 and
 * everything else (5xx, fetch failures) is a retryable NETWORK error.
 */
function fromTrpcFailure(cause: unknown): HatidError {
  const status = httpStatusOf(cause);
  if (status === 401) return new HatidError("UNAUTHORIZED", "Not signed in", { cause });
  if (status === 429) return new HatidError("RATE_LIMITED", "Too many upload requests", { cause });
  // 408 (TIMEOUT) and 499 (CLIENT_CLOSED_REQUEST) are transient: they stay retryable NETWORK errors below.
  if (status !== undefined && status >= 400 && status <= 499 && status !== 408 && status !== 499) {
    return new HatidError("INVALID_INPUT", `tRPC upload request was rejected (HTTP ${status})`, { cause });
  }
  return new HatidError("NETWORK", "tRPC upload request failed", { cause });
}

/** Client transport over your tRPC client, e.g. `trpcTransport<typeof uploads>(trpcClient.upload)`. */
export function trpcTransport<U = unknown>(client: TrpcUploadClient): Transport<U> {
  async function call<T>(m: Mutation, input: object, signal?: AbortSignal): Promise<T> {
    let outcome: ActionOutcome | undefined;
    try {
      outcome = (await m.mutate(input, signal ? { signal } : undefined)) as ActionOutcome | undefined;
    } catch (cause) {
      if (signal?.aborted) throw new HatidError("CANCELED", "Upload canceled", { cause });
      throw fromTrpcFailure(cause);
    }
    if (outcome?.ok === true) return outcome.data as T;
    if (outcome?.ok === false) throw fromWire({ error: outcome.error }, outcome.status);
    throw new HatidError("INTERNAL", "Unexpected tRPC response");
  }
  return {
    issue: (r, s) => call(client.issue, r, s),
    confirm: (r, s) => call(client.confirm, r, s),
    signParts: (r, s) => call(client.signParts, r, s),
    complete: (r, s) => call(client.complete, r, s),
    abort: (r) => call(client.abort, r),
  };
}
