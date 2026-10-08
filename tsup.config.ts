import { defineConfig } from "tsup";

const shared = { format: ["esm" as const], dts: true, sourcemap: true, target: "es2022", splitting: true, treeshake: true };

export default defineConfig([
  {
    ...shared,
    entry: { "server/index": "src/server/index.ts", "next/index": "src/next/index.ts", "trpc/index": "src/trpc/index.ts" },
    external: ["next", "@trpc/server", "@trpc/client"],
  },
  {
    ...shared,
    entry: { "react/index": "src/react/index.ts" },
    external: ["react", "react-dom"],
    treeshake: false,
    banner: { js: '"use client";' },
  },
]);
