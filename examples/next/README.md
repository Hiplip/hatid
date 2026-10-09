# hatid example: Next.js

A small App Router app showing `@hiplip/hatid`: upload with progress, confirm, list, download, delete, and an oversize file rejected at issue.

The "database" is a JSON file in `.data/`, and the "session" is a random cookie. Both are demo stand-ins; replace them with your own.

## Run it

1. `pnpm install && pnpm build` at the repo root (the example uses the built `dist`).
2. `cp examples/next/.env.example examples/next/.env` and fill it in.
3. Configure CORS once in the Cloudflare dashboard (R2 -> your bucket -> Settings -> CORS policy) for `http://localhost:3000`. The exact JSON is in the root README. The app's API token needs only Object Read & Write.
4. `pnpm --filter hatid-example-next dev`.
5. Try the checklist:
   - Upload a file and watch the progress.
   - Refresh the page: the file is still listed.
   - Download it.
   - Delete it.
   - Click the 6 MB button: the server rejects it with `FILE_TOO_LARGE`.
