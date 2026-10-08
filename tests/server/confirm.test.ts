// tests/server/confirm.test.ts
import { describe, expect, it, vi } from "vitest";
import { confirmUpload, runConfirm } from "../../src/server/low-level/confirm";
import { setup } from "../support/flow";

describe("confirmUpload", () => {
  it("moves a private upload to its final key, writes a receipt and runs onConfirmed", async () => {
    const t = setup();
    const issued = await t.issueAndPut({ route: "", input: { noteId: "n1" } });
    const onConfirmed = vi.fn();
    const result = await confirmUpload(t.r2, { key: issued.key, owner: "alice", fileName: " notes\u0000.txt ", onConfirmed });
    const finalKey = issued.key.slice("pending/".length);
    expect(result).toMatchObject({ alreadyConfirmed: false, input: { noteId: "n1" },
      file: { key: finalKey, visibility: "private", size: 3, contentType: "text/plain" } });
    expect(result.file.url).toBeUndefined();
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ owner: "alice", fileName: "notes.txt", input: { noteId: "n1" } }));
    expect(t.fake.object("priv-bucket", finalKey)?.meta["hatid-owner"]).toBeDefined();
    expect(t.fake.object("priv-bucket", `receipts/${finalKey}`)).toBeDefined();
    expect(t.fake.object("priv-bucket", issued.key)).toBeUndefined();
  });

  it("copies public uploads to the public bucket with no hatid metadata", async () => {
    const t = setup();
    const issued = await t.issueAndPut({ visibility: "public", contentType: "image/png" });
    const { file } = await confirmUpload(t.r2, { key: issued.key, owner: "alice" });
    expect(file.url).toBe(`https://files.example.com/${file.key}`);
    expect(t.fake.object("pub-bucket", file.key)).toMatchObject({ meta: {}, contentType: "image/png" });
    expect(t.fake.object("priv-bucket", file.key)).toBeUndefined();
    expect(t.fake.object("priv-bucket", `receipts/${file.key}`)).toBeDefined();
  });

  it("is idempotent for the same owner and does not re-run onConfirmed", async () => {
    const t = setup();
    const issued = await t.issueAndPut({ visibility: "public", contentType: "image/png" });
    await confirmUpload(t.r2, { key: issued.key, owner: "alice" });
    const onConfirmed = vi.fn();
    const again = await confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed });
    expect(again.alreadyConfirmed).toBe(true);
    expect(again.file.url).toContain(again.file.key);
    expect(onConfirmed).not.toHaveBeenCalled();
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "mallory" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
  });

  it("rejects a foreign owner without deleting anything", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "mallory" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice" })).resolves.toBeDefined();
  });

  it("treats missing keys, unauthenticated callers and foreign owners identically", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    const missing = await confirmUpload(t.r2, { key: issued.key.replace(/[0-9a-f]{12}$/, "000000000000"), owner: "alice" }).catch((e) => e);
    const noAuth = await runConfirm(t.r2, { key: issued.key }, { route: "", resolveOwner: async () => null }).catch((e) => e);
    const foreign = await confirmUpload(t.r2, { key: issued.key, owner: "bob" }).catch((e) => e);
    for (const e of [missing, noAuth, foreign]) expect([e.code, e.status, e.toWire().message]).toEqual(["CONFIRM_REJECTED", 404, missing.toWire().message]);
  });

  it("rejects malformed keys as INVALID_INPUT and wrong-route keys as CONFIRM_REJECTED", async () => {
    const t = setup();
    await expect(confirmUpload(t.r2, { key: "att/../../etc", owner: "alice" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const issued = await t.issueAndPut({ route: "avatar" });
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice", route: "attachment" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
  });

  it.each([
    ["size mismatch", (o: { body: Uint8Array }) => ({ ...o, body: new Uint8Array(4) })],
    ["type mismatch", (o: { contentType: string }) => ({ ...o, contentType: "text/html" })],
    ["extra metadata", (o: { meta: Record<string, string> }) => ({ ...o, meta: { ...o.meta, extra: "1" } })],
    ["bad version", (o: { meta: Record<string, string> }) => ({ ...o, meta: { ...o.meta, "hatid-v": "9" } })],
  ])("deletes the owner's invalid upload on %s", async (_name, mutate) => {
    const t = setup();
    const issued = await t.issueAndPut();
    if (issued.kind !== "single") return;
    const original = { body: new Uint8Array(3), contentType: "text/plain", meta: t.metaOf(issued.headers) };
    t.fake.putObject("priv-bucket", issued.key, mutate(original as never) as never);
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice" })).rejects.toMatchObject({ code: "UPLOAD_INVALID" });
    expect(t.fake.object("priv-bucket", issued.key)).toBeUndefined();
  });

  it("does not delete when ownership metadata is unreadable", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    if (issued.kind !== "single") return;
    t.fake.putObject("priv-bucket", issued.key, { body: new Uint8Array(3), contentType: "text/plain", meta: { ...t.metaOf(issued.headers), "hatid-owner": "!!" } });
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
  });

  it("re-checks allowedTypes at confirm", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice", allowedTypes: ["image/*"] })).rejects.toMatchObject({ code: "UPLOAD_INVALID" });
  });

  it("compensates when onConfirmed throws, and a retry succeeds", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    const finalKey = issued.key.slice("pending/".length);
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed: () => { throw new Error("db down"); } }))
      .rejects.toMatchObject({ code: "HOOK_FAILED", retryable: true });
    expect(t.fake.object("priv-bucket", finalKey)).toBeUndefined();
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
    const ok = await confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed: vi.fn() });
    expect(ok.file.key).toBe(finalKey);
  });

  it("survives two confirms racing for the same key", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    const finalKey = issued.key.slice("pending/".length);
    const [a, b] = await Promise.all([
      confirmUpload(t.r2, { key: issued.key, owner: "alice" }),
      confirmUpload(t.r2, { key: issued.key, owner: "alice" }),
    ]);
    expect(a.file.key).toBe(finalKey);
    expect(b.file.key).toBe(finalKey);
    expect(t.fake.keys("priv-bucket").filter((k) => k === finalKey)).toHaveLength(1);
    expect(t.fake.object("priv-bucket", issued.key)).toBeUndefined();
  });
  it("a failing hook racing a succeeding one never deletes the committed copy", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    const finalKey = issued.key.slice("pending/".length);
    let calls = 0;
    const hook = async () => {
      if (calls++ === 0) {
        // the failing run waits until the other run has fully committed (receipt written, pending deleted)
        for (let i = 0; i < 500 && (!t.fake.object("priv-bucket", `receipts/${finalKey}`) || t.fake.object("priv-bucket", issued.key)); i++) {
          await new Promise((r) => setTimeout(r, 2));
        }
        throw new Error("db down");
      }
    };
    const results = await Promise.allSettled([
      confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed: hook }),
      confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed: hook }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(t.fake.object("priv-bucket", finalKey)).toBeDefined();
    expect(t.fake.object("priv-bucket", `receipts/${finalKey}`)).toBeDefined();
    expect(t.fake.object("priv-bucket", issued.key)).toBeUndefined();
    const later = await confirmUpload(t.r2, { key: issued.key, owner: "alice" });
    expect(later.alreadyConfirmed).toBe(true);
    expect(t.fake.object("priv-bucket", finalKey)).toBeDefined();
  });

  it("a receipt with a lingering pending object is treated as confirmed", async () => {
    const t = setup();
    const issued = await t.issueAndPut();
    const finalKey = issued.key.slice("pending/".length);
    if (issued.kind !== "single") return;
    await t.r2.writeReceipt({ finalKey, metadata: t.metaOf(issued.headers) });
    await expect(confirmUpload(t.r2, { key: issued.key, owner: "mallory" })).rejects.toMatchObject({ code: "CONFIRM_REJECTED" });
    expect(t.fake.object("priv-bucket", issued.key)).toBeDefined();
    const onConfirmed = vi.fn();
    const r = await confirmUpload(t.r2, { key: issued.key, owner: "alice", onConfirmed });
    expect(r.alreadyConfirmed).toBe(true);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(t.fake.object("priv-bucket", issued.key)).toBeUndefined();
  });
});
