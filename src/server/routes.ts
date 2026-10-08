import type { StandardSchemaV1 } from "@standard-schema/spec";
import { HatidError } from "../core/errors";
import { validatePrefix } from "../core/keys";
import { validateOwner } from "../core/metadata";
import { validateAllowedTypes } from "../core/mime";
import type { CompletedPart, IssueResult, UploadAction, UploadedFile, Visibility } from "../core/types";
import { parseDuration, parseSize } from "../core/units";
import type { StorageBackend } from "./backend";
import { rejected, runConfirm, type OnConfirmed } from "./low-level/confirm";
import { createUploadUrl, resolveMultipart, SINGLE_PUT_MAX, type MultipartOptions, type ResolvedMultipart } from "./low-level/issue";
import { abortUpload, completeUpload, readMultipartToken, signUploadParts } from "./low-level/multipart";

type MaybePromise<T> = T | Promise<T>;
export type InputOf<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : undefined;
export type ClientInputOf<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S> : undefined;
export type AuthResult = string | { owner: string; metadata?: unknown } | null | undefined;
export type RateLimitResult = boolean | { retryAfter: number };

export type UploadRoute<TCtx, S = undefined> = {
  visibility: Visibility;
  /** Key prefix: lowercase segments [a-z0-9_-] separated by "/". */
  prefix: string;
  maxSize: number | string;
  allowedTypes: readonly string[];
  /** Standard Schema (zod, valibot, arktype…). Output must be JSON-serializable identifiers: it is stored as plaintext object metadata. */
  input?: S;
  datePrefix?: boolean;
  keyExtension?: boolean;
  keyFileName?: boolean;
  expiresIn?: number | string;
  multipart?: MultipartOptions | false;
  /** Required. Return the owner id, { owner, metadata }, or null to reject. Runs on every action. */
  auth: (args: { ctx: TCtx; input: InputOf<S> }) => MaybePromise<AuthResult>;
  rateLimit?: (args: { ctx: TCtx; owner: string; action: UploadAction }) => MaybePromise<RateLimitResult>;
  /** Runs inside the confirm request after all checks. At-least-once: upsert on file.key. */
  onConfirmed?: (args: { file: UploadedFile; owner: string; input: InputOf<S>; metadata: unknown; fileName: string | undefined; ctx: TCtx }) => MaybePromise<void>;
};

export type DefineUploadsOptions = {
  /** Server-side logging for STORAGE, HOOK_FAILED, INTERNAL and CONFIG errors. */
  onError?: (e: { error: HatidError; route: string | undefined; action: string | undefined }) => void;
};

export type ResolvedRoute = {
  name: string; visibility: Visibility; prefix: string; maxSize: number; allowedTypes: string[];
  schema: StandardSchemaV1 | undefined; datePrefix: boolean; keyExtension: boolean; keyFileName: boolean;
  expiresIn: number; multipart: ResolvedMultipart | null;
  auth: (a: { ctx: any; input: any }) => MaybePromise<AuthResult>;
  rateLimit: ((a: { ctx: any; owner: string; action: UploadAction }) => MaybePromise<RateLimitResult>) | undefined;
  onConfirmed: ((a: any) => MaybePromise<void>) | undefined;
};

export type Uploads<TCtx, TSchemas> = {
  readonly backend: StorageBackend;
  readonly routes: Readonly<Record<string, ResolvedRoute>>;
  readonly options: DefineUploadsOptions;
  /** Phantom type for client inference. Never present at runtime. */
  readonly "~types"?: { ctx: TCtx; routes: { [K in keyof TSchemas]: { input: ClientInputOf<TSchemas[K]> } } };
};
export type AnyUploads = Uploads<any, any>;

const ROUTE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function define<TCtx, TSchemas>(
  backend: StorageBackend,
  routes: { [K in keyof TSchemas]: UploadRoute<TCtx, TSchemas[K]> },
  options: DefineUploadsOptions = {},
): Uploads<TCtx, TSchemas> {
  const resolved: Record<string, ResolvedRoute> = {};
  for (const [name, def] of Object.entries(routes as Record<string, UploadRoute<TCtx, unknown>>)) {
    const where = `defineUploads: route "${name}"`;
    if (!ROUTE_NAME.test(name)) throw new HatidError("CONFIG", `${where}: names must match [A-Za-z0-9_-]{1,64}`);
    if (typeof def?.auth !== "function") throw new HatidError("CONFIG", `${where}: auth is required`);
    if (def.visibility !== "public" && def.visibility !== "private") throw new HatidError("CONFIG", `${where}: visibility must be "public" or "private"`);
    if (def.visibility === "public" && !backend.capabilities.publicBucket) {
      throw new HatidError("CONFIG", `${where}: visibility "public" requires buckets.public and publicBaseUrl in createR2Client`);
    }
    const schema = def.input as StandardSchemaV1 | undefined;
    if (schema !== undefined && typeof schema?.["~standard"]?.validate !== "function") {
      throw new HatidError("CONFIG", `${where}: input must be a Standard Schema (zod ≥3.24, valibot ≥1, arktype ≥2…)`);
    }
    const maxSize = parseSize(def.maxSize, `${where} maxSize`);
    const multipart = resolveMultipart(def.multipart);
    if (!multipart && maxSize > SINGLE_PUT_MAX) throw new HatidError("CONFIG", `${where}: maxSize above 5 GiB requires multipart`);
    let prefix: string;
    try { prefix = validatePrefix(def.prefix); } catch (e) {
      throw new HatidError("CONFIG", `${where}: ${e instanceof Error ? e.message : `invalid prefix "${String(def.prefix)}"`}`);
    }
    resolved[name] = {
      name, visibility: def.visibility, prefix, maxSize, allowedTypes: validateAllowedTypes(def.allowedTypes), schema,
      datePrefix: def.datePrefix ?? true, keyExtension: def.keyExtension ?? false, keyFileName: def.keyFileName ?? false,
      expiresIn: parseDuration(def.expiresIn ?? "10m", `${where} expiresIn`), multipart,
      auth: def.auth as ResolvedRoute["auth"], rateLimit: def.rateLimit as ResolvedRoute["rateLimit"],
      onConfirmed: def.onConfirmed as ResolvedRoute["onConfirmed"],
    };
  }
  return { backend, routes: resolved, options };
}

type Define<TCtx> = <TSchemas>(
  backend: StorageBackend,
  routes: { [K in keyof TSchemas]: UploadRoute<TCtx, TSchemas[K]> },
  options?: DefineUploadsOptions,
) => Uploads<TCtx, TSchemas>;

function defineDefault<TSchemas>(
  backend: StorageBackend,
  routes: { [K in keyof TSchemas]: UploadRoute<{ req: Request }, TSchemas[K]> },
  options?: DefineUploadsOptions,
): Uploads<{ req: Request }, TSchemas> {
  return define<{ req: Request }, TSchemas>(backend, routes, options);
}

/** Define named upload routes. Hooks get `ctx = { req }`; use `.withContext<T>()` for tRPC or custom contexts. */
export const defineUploads = Object.assign(defineDefault, {
  withContext: <TCtx>(): Define<TCtx> => (backend, routes, options) => define(backend, routes, options),
});

// ---- route operations (used by protocol.ts) ----

function routeOf(uploads: AnyUploads, name: string): ResolvedRoute {
  const route = Object.hasOwn(uploads.routes, name) ? uploads.routes[name] : undefined;
  if (!route) throw new HatidError("INVALID_INPUT", "Unknown upload route");
  return route;
}

async function validateInput(r: ResolvedRoute, value: unknown): Promise<unknown> {
  if (!r.schema) return undefined;
  const result = await r.schema["~standard"].validate(value);
  if (result.issues) throw new HatidError("INVALID_INPUT", `Invalid input: ${result.issues.map((i) => i.message).join("; ")}`);
  return result.value;
}

async function authorize(r: ResolvedRoute, ctx: unknown, input: unknown, action: UploadAction): Promise<{ owner: string; metadata: unknown } | null> {
  const res = await r.auth({ ctx, input });
  if (res === null || res === undefined) return null;
  const owner = validateOwner(typeof res === "string" ? res : res.owner);
  const metadata = typeof res === "object" ? res.metadata : undefined;
  if (r.rateLimit) {
    const verdict = await r.rateLimit({ ctx, owner, action });
    if (verdict !== true) {
      throw new HatidError("RATE_LIMITED", "Too many upload requests", typeof verdict === "object" ? { retryAfter: verdict.retryAfter } : {});
    }
  }
  return { owner, metadata };
}

function withCtx(r: ResolvedRoute, ctx: unknown): OnConfirmed | undefined {
  const hook = r.onConfirmed;
  return hook ? (a) => hook({ ...a, ctx }) : undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function routeIssue(uploads: AnyUploads, name: string, ctx: unknown, body: Record<string, unknown>): Promise<IssueResult> {
  const r = routeOf(uploads, name);
  const input = await validateInput(r, body.input);
  const auth = await authorize(r, ctx, input, "issue");
  if (!auth) throw new HatidError("UNAUTHORIZED", "Not signed in");
  if (typeof body.size !== "number") throw new HatidError("INVALID_INPUT", "size must be a number");
  return createUploadUrl(uploads.backend, {
    owner: auth.owner, metadata: auth.metadata, input, route: r.name, visibility: r.visibility, prefix: r.prefix,
    contentType: str(body.contentType) ?? "", size: body.size, maxSize: r.maxSize, allowedTypes: r.allowedTypes,
    expiresIn: r.expiresIn, datePrefix: r.datePrefix, keyExtension: r.keyExtension, keyFileName: r.keyFileName,
    fileName: str(body.fileName), multipart: r.multipart ?? false,
  });
}

export async function routeConfirm(uploads: AnyUploads, name: string, ctx: unknown, body: Record<string, unknown>): Promise<{ file: UploadedFile }> {
  const r = routeOf(uploads, name);
  const { file } = await runConfirm(uploads.backend, { key: body.key, fileName: body.fileName }, {
    route: r.name, prefix: r.prefix, allowedTypes: r.allowedTypes, onConfirmed: withCtx(r, ctx),
    resolveOwner: async ({ input }) => (await authorize(r, ctx, input, "confirm"))?.owner ?? null,
  });
  return { file };
}

async function multipartOwner(uploads: AnyUploads, r: ResolvedRoute, ctx: unknown, body: Record<string, unknown>, action: UploadAction) {
  const token = await readMultipartToken(uploads.backend, body.token, body.key, body.uploadId, r.name);
  const auth = await authorize(r, ctx, token.input, action);
  if (!auth || auth.owner !== token.owner) throw rejected();
  return { token, owner: auth.owner, raw: body.token as string };
}

export async function routeSignParts(uploads: AnyUploads, name: string, ctx: unknown, body: Record<string, unknown>) {
  const r = routeOf(uploads, name);
  const { token, owner, raw } = await multipartOwner(uploads, r, ctx, body, "signParts");
  const parts = await signUploadParts(uploads.backend, {
    key: token.key, uploadId: token.uploadId, token: raw, owner, partNumbers: body.partNumbers as number[], route: r.name, expiresIn: r.expiresIn,
  });
  return { parts };
}

export async function routeComplete(uploads: AnyUploads, name: string, ctx: unknown, body: Record<string, unknown>): Promise<{ file: UploadedFile }> {
  const r = routeOf(uploads, name);
  const { token, owner, raw } = await multipartOwner(uploads, r, ctx, body, "complete");
  const { file } = await completeUpload(uploads.backend, {
    key: token.key, uploadId: token.uploadId, token: raw, owner, parts: body.parts as CompletedPart[], fileName: str(body.fileName),
    route: r.name, prefix: r.prefix, allowedTypes: r.allowedTypes, onConfirmed: withCtx(r, ctx),
  });
  return { file };
}

export async function routeAbort(uploads: AnyUploads, name: string, ctx: unknown, body: Record<string, unknown>): Promise<{ ok: true }> {
  const r = routeOf(uploads, name);
  const { token, owner, raw } = await multipartOwner(uploads, r, ctx, body, "abort");
  await abortUpload(uploads.backend, { key: token.key, uploadId: token.uploadId, token: raw, owner, route: r.name });
  return { ok: true };
}
