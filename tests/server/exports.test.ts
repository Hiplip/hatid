import { describe, expect, it } from "vitest";
import * as server from "../../src/server";

describe("@hiplip/hatid/server exports", () => {
  it("exposes the public API", () => {
    for (const name of [
      "createR2Client", "defineUploads", "createUploadUrl", "confirmUpload", "createDownloadUrl", "publicUrl", "headFile",
      "deleteFile", "signUploadParts", "completeUpload", "abortUpload", "cleanupUnconfirmed", "createFetchHandler",
      "handleUploadAction", "runUploadAction", "HatidError", "isHatidError",
    ]) expect(typeof (server as Record<string, unknown>)[name], name).toBe("function");
  });
});
