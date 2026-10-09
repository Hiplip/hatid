import { createR2Client, type R2ClientConfig } from "../../src/server/r2";
import { FakeR2, type FakeR2Options } from "./fake-r2";

export function makeR2(o: { withPublic?: boolean; config?: Partial<R2ClientConfig>; fake?: FakeR2Options } = {}) {
  const fake = new FakeR2(o.fake);
  const withPublic = o.withPublic ?? true;
  const r2 = createR2Client({
    ...fake.creds(),
    buckets: withPublic ? { private: "priv-bucket", public: "pub-bucket" } : { private: "priv-bucket" },
    ...(withPublic ? { publicBaseUrl: "https://files.example.com" } : {}),
    fetch: fake.fetch,
    ...o.config,
  });
  /** What a browser does with an issued single upload. */
  const browserPut = (url: string, headers: Record<string, string>, body: Uint8Array | string) =>
    fake.fetch(url, { method: "PUT", headers, body: typeof body === "string" ? body : (body as Uint8Array<ArrayBuffer>) });
  return { fake, r2, browserPut };
}
