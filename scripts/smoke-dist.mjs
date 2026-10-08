// Smoke test against the BUILT package (run `pnpm build` first): `pnpm smoke:dist`.
// Unit tests import src/, where there is one HatidError class. The bundles may each carry their own
// copy, so this checks that errors are still recognised across entry points and that a tRPC error
// keeps its code and retryability inside the React upload queue.
import assert from "node:assert/strict";

const react = await import("../dist/react/index.js");
const server = await import("../dist/server/index.js");
const trpc = await import("../dist/trpc/index.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

await check("server HatidError is recognised by react isHatidError", () => {
  assert.equal(react.isHatidError(new server.HatidError("RATE_LIMITED", "x")), true);
});
await check("react HatidError is recognised by server isHatidError", () => {
  assert.equal(server.isHatidError(new react.HatidError("STORAGE", "x")), true);
});
await check("instanceof works across bundles", () => {
  assert.equal(new server.HatidError("STORAGE", "x") instanceof react.HatidError, true);
  assert.equal(new react.HatidError("STORAGE", "x") instanceof server.HatidError, true);
  assert.equal(new Error("x") instanceof react.HatidError, false);
});

const rateLimited = { ok: false, status: 429, error: { code: "RATE_LIMITED", message: "slow down", retryAfter: 3 } };
const fakeClient = (outcome) => {
  const m = { mutate: async () => outcome };
  return { issue: m, confirm: m, signParts: m, complete: m, abort: m };
};

await check("trpcTransport error is a HatidError for /react and /server", async () => {
  const transport = trpc.trpcTransport(fakeClient(rateLimited));
  const e = await transport.issue({ route: "r", input: undefined, size: 3, contentType: "text/plain" }).then(() => null, (err) => err);
  assert.ok(e, "expected the issue call to reject");
  assert.equal(react.isHatidError(e), true);
  assert.equal(server.isHatidError(e), true);
  assert.equal(e.code, "RATE_LIMITED");
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfter, 3);
});

await check("react UploadQueue keeps a tRPC RATE_LIMITED error typed and retryable", async () => {
  const queue = new react.UploadQueue({ transport: trpc.trpcTransport(fakeClient(rateLimited)), route: "r" });
  const [result] = await queue.upload(new Blob(["abc"], { type: "text/plain" }));
  assert.equal(result.status, "error");
  assert.equal(result.error?.code, "RATE_LIMITED");
  assert.equal(result.error?.retryable, true);
  assert.equal(react.isHatidError(result.error), true);
});

if (failures > 0) {
  console.error(`\nsmoke:dist: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke:dist: all checks passed");
