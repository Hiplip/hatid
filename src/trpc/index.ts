import { fromWire, HatidError } from "../core/errors";
import type { Transport } from "../react/types";
import { runUploadAction, type ActionOutcome } from "../server/protocol";
import type { AnyUploads, Uploads } from "../server/routes";

// Structural shapes so hatid needs no runtime import of @trpc/server.
type ProcedureLike = {
  input: (parser: (value: unknown) => unknown) => { mutation: (resolver: (opts: any) => Promise<unknown>) => unknown };
};
type RouterFactory<TRouter> = { router: (procedures: any) => TRouter };

export type { ActionOutcome };

/**
 * Five tRPC mutations (issue, confirm, signParts, complete, abort) backed by `uploads`.
 * Hook `ctx` is your tRPC context: define routes with `defineUploads.withContext<Context>()`.
 * `auth` stays required on every route even when `procedure` is already protected.
 *
 * The returned router's procedures are untyped passthroughs (hatid has no @trpc/server type
 * dependency). Route names and inputs are type-checked on the client instead, via
 * `trpcTransport<typeof uploads>(trpcClient.upload)` together with `useUpload`.
 */
export function createUploadRouter<TRouter, TCtx>(opts: { t: RouterFactory<TRouter>; procedure: ProcedureLike; uploads: Uploads<TCtx, any> }): TRouter {
  const mutation = (action: string) =>
    opts.procedure
      .input((value: unknown) => value)
      .mutation(({ ctx, input }: { ctx: unknown; input: unknown }) =>
        runUploadAction(opts.uploads as AnyUploads, ctx, { ...(typeof input === "object" && input !== null ? input : {}), action }));
  return opts.t.router({
    issue: mutation("issue"), confirm: mutation("confirm"), signParts: mutation("signParts"),
    complete: mutation("complete"), abort: mutation("abort"),
  });
}

type Mutation = { mutate: (input: any, opts?: { signal?: AbortSignal }) => Promise<unknown> };
export type TrpcUploadClient = { issue: Mutation; confirm: Mutation; signParts: Mutation; complete: Mutation; abort: Mutation };

/** Client transport over your tRPC client, e.g. `trpcTransport<typeof uploads>(trpcClient.upload)`. */
export function trpcTransport<U = unknown>(client: TrpcUploadClient): Transport<U> {
  async function call<T>(m: Mutation, input: object, signal?: AbortSignal): Promise<T> {
    let outcome: ActionOutcome | undefined;
    try {
      outcome = (await m.mutate(input, signal ? { signal } : undefined)) as ActionOutcome | undefined;
    } catch (cause) {
      if (signal?.aborted) throw new HatidError("CANCELED", "Upload canceled", { cause });
      throw new HatidError("NETWORK", "tRPC upload request failed", { cause });
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
