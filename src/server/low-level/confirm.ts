import { HatidError } from "../../core/errors";
import { cleanDisplayName } from "../../core/filename";
import { finalKeyOf, isPendingKey, validatePrefix } from "../../core/keys";
import { decodeSignedMeta, type SignedMeta } from "../../core/metadata";
import { isAllowedType, normalizeContentType } from "../../core/mime";
import type { UploadedFile } from "../../core/types";
import type { StorageBackend } from "../backend";

export type OnConfirmed = (a: {
  file: UploadedFile; owner: string; input: unknown; metadata: unknown; fileName: string | undefined;
}) => Promise<void> | void;

export type ConfirmHooks = {
  /** Route name that must match the signed metadata ("" for low-level use). */
  route: string;
  /** Restrict keys to this route prefix. */
  prefix?: string | undefined;
  /** Current allowed types, re-checked at confirm. */
  allowedTypes?: readonly string[] | undefined;
  /** Returns the caller's owner id from the server session, or null. Receives the signed issue-time input. */
  resolveOwner: (signed: { input: unknown; metadata: unknown }) => Promise<string | null>;
  onConfirmed?: OnConfirmed | undefined;
};

export type ConfirmResult = { file: UploadedFile; input: unknown; metadata: unknown; alreadyConfirmed: boolean };

/** Uniform rejection: missing key, failed auth and foreign owner are indistinguishable. */
export const rejected = () => new HatidError("CONFIRM_REJECTED", "Upload not found");

function fileOf(backend: StorageBackend, key: string, meta: SignedMeta): UploadedFile {
  const file: UploadedFile = { key, visibility: meta.visibility, size: meta.size, contentType: meta.type };
  if (meta.visibility === "public" && backend.capabilities.publicBaseUrl) {
    file.url = `${backend.capabilities.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  return file;
}

export async function runConfirm(backend: StorageBackend, req: { key: unknown; fileName?: unknown }, hooks: ConfirmHooks): Promise<ConfirmResult> {
  // A bad prefix is a CONFIG error, never a RegExp SyntaxError or a widened match in isPendingKey.
  if (hooks.prefix !== undefined) validatePrefix(hooks.prefix);
  if (!isPendingKey(req.key, hooks.prefix)) throw new HatidError("INVALID_INPUT", "Invalid upload key");
  const key = req.key;

  const state = await backend.inspect({ key });
  if (state.state === "missing") throw rejected();
  const decoded = decodeSignedMeta(state.metadata);
  if (!decoded || decoded.meta.route !== hooks.route) throw rejected();
  const { meta } = decoded;

  const owner = await hooks.resolveOwner({ input: meta.input, metadata: meta.metadata });
  if (owner === null || owner !== meta.owner) throw rejected();

  const finalKey = finalKeyOf(key);
  const file = fileOf(backend, finalKey, meta);
  if (state.state === "confirmed") {
    // Owner is proven: tidy a pending object left behind by a crash between receipt and delete.
    await backend.deleteObject({ key, bucket: "private" }).catch(() => {});
    return { file, input: meta.input, metadata: meta.metadata, alreadyConfirmed: true };
  }

  // The caller is proven to be the owner from here on, so deleting an invalid object is safe.
  const typeOk = normalizeContentType(state.contentType) === meta.type &&
    (hooks.allowedTypes === undefined || isAllowedType(meta.type, hooks.allowedTypes));
  if (!decoded.valid || state.size !== meta.size || state.size > meta.maxSize || !typeOk) {
    await backend.deleteObject({ key, bucket: "private" });
    throw new HatidError("UPLOAD_INVALID", "The uploaded file did not match what was issued and was deleted");
  }

  try {
    await backend.promote({ pendingKey: key, finalKey, visibility: meta.visibility, contentType: meta.type, size: state.size, metadata: state.metadata });
  } catch (error) {
    // A concurrent confirm may have finished first and removed the pending object.
    const again = await backend.inspect({ key }).catch(() => null);
    if (again?.state === "confirmed") return { file, input: meta.input, metadata: meta.metadata, alreadyConfirmed: true };
    throw error;
  }

  if (hooks.onConfirmed) {
    try {
      await hooks.onConfirmed({ file, owner, input: meta.input, metadata: meta.metadata, fileName: cleanDisplayName(req.fileName) });
    } catch (cause) {
      // Never destroy a committed result: if a concurrent run already wrote its receipt, keep the final copy.
      // Residual window: a run may still write its receipt right after this re-check (onConfirmed is at-least-once).
      const now = await backend.inspect({ key }).catch(() => null);
      if (now?.state === "confirmed") return { file, input: meta.input, metadata: meta.metadata, alreadyConfirmed: true };
      await backend.deleteObject({ key: finalKey, bucket: meta.visibility }).catch(() => {});
      throw new HatidError("HOOK_FAILED", `onConfirmed failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }

  await backend.writeReceipt({ finalKey, metadata: state.metadata });
  await backend.deleteObject({ key, bucket: "private" });
  return { file, input: meta.input, metadata: meta.metadata, alreadyConfirmed: false };
}

export function confirmUpload(backend: StorageBackend, o: {
  key: string; owner: string; fileName?: string | undefined; route?: string | undefined; prefix?: string | undefined;
  allowedTypes?: readonly string[] | undefined; onConfirmed?: OnConfirmed | undefined;
}): Promise<ConfirmResult> {
  return runConfirm(backend, { key: o.key, fileName: o.fileName }, {
    route: o.route ?? "", prefix: o.prefix, allowedTypes: o.allowedTypes, onConfirmed: o.onConfirmed,
    resolveOwner: async () => o.owner,
  });
}
