import { HatidError } from "../core/errors";
import { clientContentType } from "../core/mime";
import type { CompletedPart, UploadedFile } from "../core/types";
import { uploadMultipart } from "./multipart";
import type { BatchResult, QueueSnapshot, Transport, UploadItem, UploadSource } from "./types";
import { xhrPut, type XhrFactory } from "./xhr";

export type QueueOptions = {
  transport: Transport<any>;
  route: string;
  input?: unknown;
  /** Send the file name at issue time (only for routes with keyFileName: true). */
  keyFileName?: boolean | undefined;
  /** Client-side UX limit per upload() call. The server does not enforce batch counts. */
  maxFiles?: number | undefined;
  /** Files in parallel (default 3). */
  concurrency?: number | undefined;
  /** Parts in parallel per multipart file (default 4). */
  partConcurrency?: number | undefined;
  onComplete?: ((result: { id: string; file: UploadedFile; fileName: string | undefined }) => void) | undefined;
  onAllComplete?: ((results: BatchResult[]) => void) | undefined;
  onError?: ((item: UploadItem) => void) | undefined;
  /** @internal testing hook */
  createXhr?: XhrFactory | undefined;
  /** @internal testing hook */
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

type Normalized = { body: Blob; size: number; type: string; fileName: string | undefined };
type Internal = UploadItem & {
  source: Normalized; input: unknown; controller: AbortController | undefined;
  key: string | undefined; uploaded: boolean;
  multipart: { key: string; uploadId: string; token: string; parts: CompletedPart[] | undefined } | undefined;
};
type Batch = { items: Internal[]; resolve: (r: BatchResult[]) => void; settledOnce: boolean };

const SETTLED = new Set(["success", "error", "canceled"]);
let counter = 0;
const newId = () => `u${Date.now().toString(36)}${(counter++).toString(36)}`;

export function normalizeSource(source: UploadSource): Normalized {
  if (typeof File !== "undefined" && source instanceof File) {
    return { body: source, size: source.size, type: clientContentType(source.type), fileName: source.name || undefined };
  }
  if (source instanceof Blob) return { body: source, size: source.size, type: clientContentType(source.type), fileName: undefined };
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const blob = new Blob([source as BlobPart]);
    return { body: blob, size: blob.size, type: "application/octet-stream", fileName: undefined };
  }
  if (typeof source === "object" && source !== null && "data" in source) {
    const inner = normalizeSource(source.data);
    return { ...inner, type: source.type !== undefined ? clientContentType(source.type) : inner.type, fileName: source.fileName ?? inner.fileName };
  }
  throw new HatidError("INVALID_INPUT", "Unsupported upload source");
}

export class UploadQueue {
  private opts: QueueOptions;
  private items: Internal[] = [];
  private batches = new Map<string, Batch>();
  private listeners = new Set<() => void>();
  private snapshot: QueueSnapshot = { items: [], progress: 0, status: "idle", error: undefined };
  private active = 0;

  constructor(opts: QueueOptions) { this.opts = opts; }

  setOptions(opts: QueueOptions): void { this.opts = opts; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): QueueSnapshot => this.snapshot;

  upload(sources: UploadSource | UploadSource[], opts: { input?: unknown } = {}): Promise<BatchResult[]> {
    const list = Array.isArray(sources) ? sources : [sources];
    const batchId = newId();
    const input = "input" in opts ? opts.input : this.opts.input;
    const max = this.opts.maxFiles;
    const created = list.map((src, index): Internal => {
      let source: Normalized = { body: new Blob([]), size: 0, type: "application/octet-stream", fileName: undefined };
      let error: HatidError | undefined;
      try { source = normalizeSource(src); } catch (e) { error = e instanceof HatidError ? e : new HatidError("INVALID_INPUT", String(e)); }
      if (!error && max !== undefined && index >= max) error = new HatidError("TOO_MANY_FILES", `At most ${max} files per upload`);
      return {
        id: newId(), batchId, fileName: source.fileName, size: source.size, type: source.type,
        status: error ? "error" : "queued", progress: 0, loaded: 0, error, result: undefined,
        source, input, controller: undefined, key: undefined, uploaded: false, multipart: undefined,
      };
    });
    this.items.push(...created);
    const done = new Promise<BatchResult[]>((resolve) => this.batches.set(batchId, { items: created, resolve, settledOnce: false }));
    for (const item of created) if (item.status === "error") this.opts.onError?.(this.view(item));
    this.emit();
    const hadQueued = created.some((c) => c.status === "queued");
    this.pump();
    // Items settled synchronously inside pump() already settled the batch from run()'s finally.
    if (!hadQueued) this.settle(batchId);
    return done;
  }

  cancel(id?: string): void {
    for (const item of this.items) {
      if (id !== undefined && item.id !== id) continue;
      if (item.status === "queued") {
        this.patch(item, { status: "canceled", error: new HatidError("CANCELED", "Upload canceled") });
        this.settle(item.batchId);
      } else if (item.controller) {
        item.controller.abort();
        if (item.multipart && !item.uploaded) this.abortMultipart(item);
      }
    }
  }

  retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "error" || !item.error?.retryable) return Promise.resolve();
    if (!item.uploaded) {
      if (item.multipart) this.abortMultipart(item);
      item.multipart = undefined;
      item.key = undefined;
    }
    this.patch(item, { status: "queued", error: undefined });
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => { if (SETTLED.has(item.status)) { unsubscribe(); resolve(); } });
    });
    this.pump();
    return finished;
  }

  reset(): void {
    this.items = this.items.filter((i) => !SETTLED.has(i.status));
    for (const [id, batch] of this.batches) {
      if (!batch.items.some((i) => this.items.includes(i))) this.batches.delete(id);
    }
    this.emit();
  }

  private abortMultipart(item: Internal): void {
    const m = item.multipart;
    if (m) void this.opts.transport.abort({ route: this.opts.route, key: m.key, uploadId: m.uploadId, token: m.token }).catch(() => {});
  }

  private pump(): void {
    const limit = Math.max(1, this.opts.concurrency ?? 3);
    while (this.active < limit) {
      const next = this.items.find((i) => i.status === "queued");
      if (!next) return;
      this.active++;
      void this.run(next).finally(() => { this.active--; this.pump(); });
    }
  }

  private async run(item: Internal): Promise<void> {
    const controller = new AbortController();
    item.controller = controller;
    const { signal } = controller;
    const { transport, route } = this.opts;
    try {
      let file: UploadedFile;
      if (item.uploaded && item.key) {
        this.patch(item, { status: "confirming" });
        file = await this.finish(item, signal);
      } else {
        this.patch(item, { status: "issuing", loaded: 0, progress: 0, error: undefined });
        const issued = await transport.issue({
          route, input: item.input, size: item.source.size, contentType: item.source.type,
          ...(this.opts.keyFileName && item.source.fileName ? { fileName: item.source.fileName } : {}),
        }, signal);
        item.key = issued.key;
        this.patch(item, { status: "uploading" });
        if (issued.kind === "single") {
          await xhrPut({ url: issued.url, headers: issued.headers, body: item.source.body, signal, createXhr: this.opts.createXhr,
            onProgress: (l) => this.progress(item, l) });
          item.uploaded = true;
          this.patch(item, { status: "confirming" });
          file = (await transport.confirm({ route, key: issued.key, fileName: item.source.fileName }, signal)).file;
        } else {
          item.multipart = { key: issued.key, uploadId: issued.uploadId, token: issued.token, parts: undefined };
          file = (await uploadMultipart({
            transport, route, issued, body: item.source.body, fileName: item.source.fileName, signal,
            onProgress: (l) => this.progress(item, l),
            onPartsDone: (parts) => { item.uploaded = true; item.multipart!.parts = parts; this.patch(item, { status: "confirming" }); },
            partConcurrency: this.opts.partConcurrency, createXhr: this.opts.createXhr, sleep: this.opts.sleep,
          })).file;
        }
      }
      this.patch(item, { status: "success", result: file, progress: 1, loaded: item.size });
      try { this.opts.onComplete?.({ id: item.id, file, fileName: item.fileName }); } catch { /* app callback bugs must never change item state */ }
    } catch (e) {
      if (signal.aborted || (e instanceof HatidError && e.code === "CANCELED")) {
        this.patch(item, { status: "canceled", error: new HatidError("CANCELED", "Upload canceled") });
      } else {
        const error = e instanceof HatidError ? e : new HatidError("INTERNAL", e instanceof Error ? e.message : String(e), { cause: e });
        this.patch(item, { status: "error", error });
        this.opts.onError?.(this.view(item));
      }
    } finally {
      item.controller = undefined;
      this.settle(item.batchId);
    }
  }

  /** Retry path after bytes reached R2: confirm, or (multipart) complete if the upload was never completed. */
  private async finish(item: Internal, signal: AbortSignal): Promise<UploadedFile> {
    const { transport, route } = this.opts;
    const fileName = item.source.fileName;
    try {
      return (await transport.confirm({ route, key: item.key!, fileName }, signal)).file;
    } catch (e) {
      const m = item.multipart;
      if (!m || !(e instanceof HatidError) || e.code !== "CONFIRM_REJECTED") throw e;
      return (await transport.complete({ route, key: m.key, uploadId: m.uploadId, token: m.token, parts: m.parts ?? [], fileName }, signal)).file;
    }
  }

  private settle(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    const items = batch.items;
    if (items.length === 0 || items.some((i) => !SETTLED.has(i.status))) return;
    const results: BatchResult[] = items.map((i) => ({
      id: i.id, status: i.status as BatchResult["status"], fileName: i.fileName,
      ...(i.result ? { file: i.result } : {}), ...(i.error ? { error: i.error } : {}),
    }));
    if (!batch.settledOnce) { batch.settledOnce = true; batch.resolve(results); }
    this.opts.onAllComplete?.(results);
  }

  private progress(item: Internal, loaded: number): void {
    item.loaded = Math.min(loaded, item.size);
    item.progress = item.size > 0 ? item.loaded / item.size : 1;
    this.emit();
  }

  private patch(item: Internal, changes: Partial<Internal>): void {
    Object.assign(item, changes);
    this.emit();
  }

  private view(i: Internal): UploadItem {
    return { id: i.id, batchId: i.batchId, fileName: i.fileName, size: i.size, type: i.type, status: i.status,
      progress: i.progress, loaded: i.loaded, error: i.error, result: i.result };
  }

  private emit(): void {
    const counted = this.items.filter((i) => i.status !== "canceled" && !(i.status === "error" && !i.uploaded));
    const total = counted.reduce((a, i) => a + i.size, 0);
    const loaded = counted.reduce((a, i) => a + (i.status === "success" ? i.size : i.loaded), 0);
    const busy = this.items.some((i) => i.status === "queued" || i.status === "issuing" || i.status === "uploading" || i.status === "confirming");
    const firstError = this.items.find((i) => i.status === "error")?.error;
    this.snapshot = {
      items: this.items.map((i) => this.view(i)),
      progress: total > 0 ? loaded / total : this.items.some((i) => i.status === "success") ? 1 : 0,
      status: busy ? "uploading" : firstError ? "error" : this.items.some((i) => i.status === "success") ? "success" : "idle",
      error: firstError,
    };
    for (const listener of this.listeners) listener();
  }
}
