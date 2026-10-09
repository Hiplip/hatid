import { HatidError } from "../core/errors";

export type XhrFactory = () => XMLHttpRequest;
export type PutOptions = {
  url: string;
  headers: Record<string, string>;
  body: Blob;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
  createXhr?: XhrFactory | undefined;
};

// Browsers refuse to let scripts set these; the signed value is satisfied by the actual body.
const FORBIDDEN = new Set(["host", "content-length"]);

/** PUT with upload progress (fetch has none). Resolves with the response ETag. */
export function xhrPut(o: PutOptions): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(new HatidError("CANCELED", "Upload canceled"));
    const xhr = o.createXhr ? o.createXhr() : new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    o.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => o.signal.removeEventListener("abort", onAbort);
    xhr.open("PUT", o.url);
    for (const [name, value] of Object.entries(o.headers)) {
      if (!FORBIDDEN.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) o.onProgress(e.loaded); };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        o.onProgress(o.body.size);
        resolve({ etag: xhr.getResponseHeader("ETag") });
      } else {
        reject(new HatidError("NETWORK", `Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new HatidError("NETWORK", "Upload failed (network error or bucket CORS policy)")); };
    xhr.onabort = () => { cleanup(); reject(new HatidError("CANCELED", "Upload canceled")); };
    xhr.send(o.body);
  });
}
