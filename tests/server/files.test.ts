import { describe, expect, it } from "vitest";
import { createDownloadUrl, deleteFile, headFile, publicUrl } from "../../src/server/low-level/files";
import { makeR2 } from "../support/r2";

describe("file helpers", () => {
  it("creates private download URLs with RFC 6266 names and a 5-minute default", async () => {
    const { r2, fake } = makeR2();
    fake.putObject("priv-bucket", "att/k", { body: new TextEncoder().encode("hello") });
    const url = await createDownloadUrl(r2, { key: "att/k", downloadName: "résumé.pdf" });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("300");
    const res = await fake.fetch(url);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
  });

  it("refuses pending and receipt keys everywhere", async () => {
    const { r2 } = makeR2();
    for (const key of ["pending/att/x", "receipts/att/x"]) {
      await expect(createDownloadUrl(r2, { key })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(() => publicUrl(r2, key)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      await expect(headFile(r2, { key, visibility: "private" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(deleteFile(r2, { key, visibility: "private" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("builds encoded public URLs and requires a public bucket", () => {
    expect(publicUrl(makeR2().r2, "avatars/2026/01/a b.png")).toBe("https://files.example.com/avatars/2026/01/a%20b.png");
    expect(() => publicUrl(makeR2({ withPublic: false }).r2, "a/b")).toThrowError(expect.objectContaining({ code: "CONFIG" }));
  });

  it("heads and deletes in the right bucket", async () => {
    const { r2, fake } = makeR2();
    fake.putObject("pub-bucket", "av/x", { body: new Uint8Array(2) });
    expect(await headFile(r2, { key: "av/x", visibility: "public" })).toMatchObject({ size: 2 });
    await deleteFile(r2, { key: "av/x", visibility: "public" });
    expect(await headFile(r2, { key: "av/x", visibility: "public" })).toBeNull();
    await expect(deleteFile(makeR2({ withPublic: false }).r2, { key: "a/b", visibility: "public" })).rejects.toMatchObject({ code: "CONFIG" });
  });
});
