import type { HatidError } from "../core/errors";
import type { CompletedPart, IssueResult, SignedPart, UploadedFile } from "../core/types";

export type IssueRequest = { route: string; input: unknown; size: number; contentType: string; fileName?: string | undefined };
export type ConfirmRequest = { route: string; key: string; fileName?: string | undefined };
export type SignPartsRequest = { route: string; key: string; uploadId: string; token: string; partNumbers: number[] };
export type CompleteRequest = { route: string; key: string; uploadId: string; token: string; parts: CompletedPart[]; fileName?: string | undefined };
export type AbortRequest = { route: string; key: string; uploadId: string; token: string };

/** How the browser talks to your server. `httpTransport` and `trpcTransport` implement it; custom ones are plain objects. */
export interface Transport<U = unknown> {
  issue(req: IssueRequest, signal?: AbortSignal): Promise<IssueResult>;
  confirm(req: ConfirmRequest, signal?: AbortSignal): Promise<{ file: UploadedFile }>;
  signParts(req: SignPartsRequest, signal?: AbortSignal): Promise<{ parts: SignedPart[] }>;
  complete(req: CompleteRequest, signal?: AbortSignal): Promise<{ file: UploadedFile }>;
  abort(req: AbortRequest): Promise<{ ok: true }>;
  /** Phantom: carries `typeof uploads` for route/input inference. */
  readonly "~uploads"?: U;
}

export type UploadSource =
  | File | Blob | ArrayBuffer | ArrayBufferView
  | { data: Blob | ArrayBuffer | ArrayBufferView; type?: string; fileName?: string };

export type ItemStatus = "queued" | "issuing" | "uploading" | "confirming" | "success" | "error" | "canceled";

export type UploadItem = {
  id: string; batchId: string; fileName: string | undefined; size: number; type: string;
  status: ItemStatus; progress: number; loaded: number; error: HatidError | undefined; result: UploadedFile | undefined;
};

export type BatchResult = {
  id: string; status: "success" | "error" | "canceled"; fileName: string | undefined; file?: UploadedFile; error?: HatidError;
};

export type QueueStatus = "idle" | "uploading" | "success" | "error";
export type QueueSnapshot = { items: readonly UploadItem[]; progress: number; status: QueueStatus; error: HatidError | undefined };
