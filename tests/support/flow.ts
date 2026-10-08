import { expect } from "vitest";
import { createUploadUrl, type CreateUploadUrlOptions } from "../../src/server/low-level/issue";
import { makeR2 } from "./r2";

export function setup(o: Parameters<typeof makeR2>[0] = {}) {
  const env = makeR2(o);
  const defaults: CreateUploadUrlOptions = {
    owner: "alice", visibility: "private", prefix: "att", contentType: "text/plain", size: 3,
    maxSize: "1MB", allowedTypes: ["text/plain", "image/*"],
  };
  async function issue(overrides: Partial<CreateUploadUrlOptions> = {}) {
    return createUploadUrl(env.r2, { ...defaults, ...overrides });
  }
  async function issueAndPut(overrides: Partial<CreateUploadUrlOptions> = {}, body: Uint8Array = new Uint8Array(overrides.size ?? 3)) {
    const issued = await issue({ size: body.byteLength, ...overrides });
    if (issued.kind !== "single") throw new Error("expected a single upload");
    expect((await env.browserPut(issued.url, issued.headers, body)).status).toBe(200);
    return issued;
  }
  /** x-amz-meta-* headers → metadata record (to fabricate tampered objects directly in the fake). */
  const metaOf = (headers: Record<string, string>) =>
    Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.slice(11), v]));
  return { ...env, defaults, issue, issueAndPut, metaOf };
}
