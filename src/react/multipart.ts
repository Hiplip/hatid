import { HatidError } from "../core/errors";
import type { CompletedPart, MultipartIssue, SignedPart, UploadedFile } from "../core/types";
import type { Transport } from "./types";
import { xhrPut, type XhrFactory } from "./xhr";

export type MultipartUploadOptions = {
  transport: Transport<any>;
  route: string;
  issued: MultipartIssue;
  body: Blob;
  fileName: string | undefined;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
  onPartsDone?: ((parts: CompletedPart[]) => void) | undefined;
  partConcurrency?: number | undefined;
  retries?: number | undefined;
  createXhr?: XhrFactory | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

export async function uploadMultipart(o: MultipartUploadOptions): Promise<{ file: UploadedFile }> {
  const { issued, transport, route } = o;
  const concurrency = Math.max(1, o.partConcurrency ?? 4);
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const batchSize = Math.min(100, concurrency * 2);

  // Internal controller: the first failure stops sibling parts.
  const inner = new AbortController();
  const forward = () => inner.abort();
  o.signal.addEventListener("abort", forward, { once: true });
  if (o.signal.aborted) inner.abort();

  const loaded = new Map<number, number>();
  const report = () => o.onProgress([...loaded.values()].reduce((a, b) => a + b, 0));
  const etags = new Map<number, string>();
  const signed = new Map<number, SignedPart>();
  let signing: Promise<void> | null = null;

  const ensureSigned = async (n: number) => {
    while (!signed.has(n)) {
      let started = false;
      if (!signing) {
        started = true;
        const numbers: number[] = [];
        for (let k = n; k <= issued.partCount && numbers.length < batchSize; k++) if (!signed.has(k) && !etags.has(k)) numbers.push(k);
        signing = transport.signParts({ route, key: issued.key, uploadId: issued.uploadId, token: issued.token, partNumbers: numbers }, inner.signal)
          .then(({ parts }) => { for (const p of parts) signed.set(p.partNumber, p); })
          .finally(() => { signing = null; });
      }
      await signing;
      if (started && !signed.has(n)) throw new HatidError("STORAGE", "Server did not sign part " + n);
    }
  };

  const uploadPart = async (n: number) => {
    const start = (n - 1) * issued.partSize;
    const blob = o.body.slice(start, Math.min(o.body.size, start + issued.partSize));
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt > 0) signed.delete(n); // re-sign: the URL may have expired
        await ensureSigned(n);
        const part = signed.get(n)!;
        const { etag } = await xhrPut({
          url: part.url, headers: part.headers, body: blob, signal: inner.signal, createXhr: o.createXhr,
          onProgress: (l) => { loaded.set(n, l); report(); },
        });
        if (!etag) {
          throw new HatidError("CONFIG", 'R2 did not expose the ETag header. Add "ETag" to ExposeHeaders in the bucket CORS policy.');
        }
        etags.set(n, etag);
        loaded.set(n, blob.size);
        report();
        return;
      } catch (error) {
        loaded.set(n, 0);
        report();
        const fatal = inner.signal.aborted || (error instanceof HatidError && !error.retryable) || attempt >= retries;
        if (fatal) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
  };

  try {
    let next = 1;
    const worker = async () => {
      while (next <= issued.partCount && !inner.signal.aborted) await uploadPart(next++);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, issued.partCount) }, worker));
    if (o.signal.aborted || inner.signal.aborted) throw new HatidError("CANCELED", "Upload canceled");
    if (etags.size !== issued.partCount) throw new HatidError("INTERNAL", "Multipart upload finished with missing parts");
  } catch (error) {
    inner.abort();
    throw o.signal.aborted ? new HatidError("CANCELED", "Upload canceled") : error;
  } finally {
    o.signal.removeEventListener("abort", forward);
  }

  const parts = [...etags].map(([partNumber, etag]) => ({ partNumber, etag })).sort((a, b) => a.partNumber - b.partNumber);
  o.onPartsDone?.(parts);
  return transport.complete({ route, key: issued.key, uploadId: issued.uploadId, token: issued.token, parts, fileName: o.fileName }, o.signal);
}
