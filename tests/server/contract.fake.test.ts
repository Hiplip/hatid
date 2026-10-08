import { runBackendContract } from "../contract/backend-contract";
import { makeR2 } from "../support/r2";

runBackendContract("fake R2", () => {
  const { r2, fake } = makeR2();
  return { backend: r2, http: fake.fetch, prefix: "contract", live: false };
});
