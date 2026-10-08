type Progress = ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;

const sizeOf = (b: unknown) => (b instanceof Blob ? b.size : 0);
const defaultScript = (x: FakeXhr) => queueMicrotask(() => {
  x.progress(sizeOf(x.body), sizeOf(x.body));
  x.respond(200, { etag: `"etag-${FakeXhr.all.indexOf(x) + 1}"` });
});

export class FakeXhr {
  static all: FakeXhr[] = [];
  /** Decides what happens after send(). Replace per test. */
  static script: (x: FakeXhr) => void = defaultScript;
  static reset() { FakeXhr.all = []; FakeXhr.script = defaultScript; }

  method = ""; url = ""; headers: Record<string, string> = {}; body: unknown = undefined; status = 0; aborted = false;
  upload: { onprogress: Progress } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private responseHeaders: Record<string, string> = {};

  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  send(body: unknown) { this.body = body; FakeXhr.all.push(this); FakeXhr.script(this); }
  abort() { if (this.aborted) return; this.aborted = true; this.onabort?.(); }
  getResponseHeader(name: string) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  progress(loaded: number, total: number) { if (!this.aborted) this.upload.onprogress?.({ loaded, total, lengthComputable: true }); }
  respond(status: number, headers: Record<string, string> = {}) {
    if (this.aborted) return;
    this.status = status;
    this.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.onload?.();
  }
  fail() { if (!this.aborted) this.onerror?.(); }
}

export const createFakeXhr = () => new FakeXhr() as unknown as XMLHttpRequest;
