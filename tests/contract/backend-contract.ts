import { beforeAll, describe, expect, it } from "vitest";
import type { StorageBackend } from "../../src/server/backend";
import { cleanupUnconfirmed } from "../../src/server/low-level/cleanup";
import { confirmUpload } from "../../src/server/low-level/confirm";
import { createDownloadUrl, deleteFile, headFile } from "../../src/server/low-level/files";
import { createUploadUrl, type CreateUploadUrlOptions } from "../../src/server/low-level/issue";
import { completeUpload, signUploadParts } from "../../src/server/low-level/multipart";
import { sameBytes } from "../support/bytes";

export type ContractEnv = {
  backend: StorageBackend;
  /** Performs a raw HTTP request (the browser's role). */
  http: (url: string, init?: RequestInit) => Promise<Response>;
  /** Unique key prefix for this run, e.g. "itest/run-123". */
  prefix: string;
  /** True against real R2 (informational; lets future cases skip fake-only checks). */
  live: boolean;
};

const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runBackendContract(name: string, setup: () => ContractEnv | Promise<ContractEnv>) {
  describe(`backend contract: ${name}`, () => {
    let env: ContractEnv;
    beforeAll(async () => { env = await setup(); });

    const issue = (o: Partial<CreateUploadUrlOptions> = {}) => createUploadUrl(env.backend, {
      owner: "alice", visibility: "private", prefix: env.prefix, contentType: "text/plain", size: 5,
      maxSize: "100MB", allowedTypes: ["text/plain"], ...o,
    });
    async function put(o: Partial<CreateUploadUrlOptions> = {}, body = new TextEncoder().encode("hello"), headers: Record<string, string> = {}) {
      const issued = await issue({ size: body.byteLength, ...o });
      if (issued.kind !== "single") throw new Error("expected single");
      const res = await env.http(issued.url, { method: "PUT", headers: { ...issued.headers, ...headers }, body });
      return { issued, res };
    }

    it("happy path: issue → upload → confirm → download → delete", async () => {
      const { issued, res } = await put();
      expect(res.status).toBe(200);
      const { file } = await confirmUpload(env.backend, { key: issued.key, owner: "alice" });
      expect(file.key).toBe(issued.key.slice("pending/".length));
      expect(await headFile(env.backend, { key: file.key, visibility: "private" })).toMatchObject({ size: 5 });
      const download = await env.http(await createDownloadUrl(env.backend, { key: file.key, downloadName: "hello.txt" }));
      expect(await download.text()).toBe("hello");
      expect(download.headers.get("content-disposition")).toContain("hello.txt");
      expect((await confirmUpload(env.backend, { key: issued.key, owner: "alice" })).alreadyConfirmed).toBe(true);
      await deleteFile(env.backend, { key: file.key, visibility: "private" });
      expect(await headFile(env.backend, { key: file.key, visibility: "private" })).toBeNull();
    });

    it("tampered signed metadata is rejected by storage", async () => {
      const { res } = await put({}, undefined, { "x-amz-meta-hatid-owner": "bWFsbG9yeQ" });
      expect(res.status).toBe(403);
    });

    it("a different content type is rejected by storage", async () => {
      const { res } = await put({}, undefined, { "content-type": "text/html" });
      expect(res.status).toBe(403);
    });

    it("oversize bodies never confirm", async () => {
      const issued = await issue({ size: 5 });
      if (issued.kind !== "single") throw new Error("expected single");
      const res = await env.http(issued.url, { method: "PUT", headers: issued.headers, body: new Uint8Array(6) });
      if (res.status === 200) {
        await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice" })).rejects.toMatchObject({ code: "UPLOAD_INVALID" });
      } else {
        expect(res.status).toBe(403);
        await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
      }
    });

    it("wrong owner is rejected and the upload survives", async () => {
      const { issued } = await put();
      await expect(confirmUpload(env.backend, { key: issued.key, owner: "mallory" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
      await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice" })).resolves.toBeDefined();
    });

    it("expired URLs are rejected", async () => {
      const issued = await issue({ expiresIn: "1s" });
      if (issued.kind !== "single") throw new Error("expected single");
      await sleep(2500);
      const res = await env.http(issued.url, { method: "PUT", headers: issued.headers, body: new TextEncoder().encode("hello") });
      expect(res.status).toBe(403);
    });

    it("onConfirmed failure compensates and a retry succeeds", async () => {
      const { issued } = await put();
      await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice", onConfirmed: () => { throw new Error("db"); } }))
        .rejects.toMatchObject({ code: "HOOK_FAILED" });
      const finalKey = issued.key.slice("pending/".length);
      expect(await headFile(env.backend, { key: finalKey, visibility: "private" })).toBeNull();
      await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice" })).resolves.toBeDefined();
    });

    it("multipart: sign parts, upload, complete", async () => {
      const issued = await issue({ size: 6 * MiB, contentType: "text/plain", multipart: { threshold: "5MB", partSize: "5MB" } });
      if (issued.kind !== "multipart") throw new Error("expected multipart");
      const parts = await signUploadParts(env.backend, { ...issued, owner: "alice", partNumbers: [1, 2] });
      const body = new Uint8Array(6 * MiB).map((_, i) => i % 256);
      const etags = [];
      for (const p of parts) {
        const start = (p.partNumber - 1) * issued.partSize;
        const res = await env.http(p.url, { method: "PUT", headers: p.headers, body: body.slice(start, start + issued.partSize) });
        expect(res.status).toBe(200);
        etags.push({ partNumber: p.partNumber, etag: res.headers.get("etag")! });
      }
      const { file } = await completeUpload(env.backend, { ...issued, owner: "alice", parts: etags });
      const download = await env.http(await createDownloadUrl(env.backend, { key: file.key }));
      const downloaded = new Uint8Array(await download.arrayBuffer());
      expect(downloaded.byteLength).toBe(body.byteLength);
      expect(sameBytes(downloaded, body)).toBe(true);
      await deleteFile(env.backend, { key: file.key, visibility: "private" });
    });

    it("cleanup removes stale unconfirmed uploads", async () => {
      const { issued } = await put();
      // 2s margin (4s sleep vs 2s cutoff) covers clock skew between the runner and R2.
      await sleep(4000);
      const result = await cleanupUnconfirmed(env.backend, { olderThan: "2s", receiptTtl: "1000d", limit: 1000 });
      expect(result.deleted.pending).toBeGreaterThanOrEqual(1);
      await expect(confirmUpload(env.backend, { key: issued.key, owner: "alice" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    });
  });
}
