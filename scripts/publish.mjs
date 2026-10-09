// Publishes the root package with npm (OIDC trusted publishing) if this version isn't on npm yet.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const spec = `${pkg.name}@${pkg.version}`;
let published = false;
try {
  published = execSync(`npm view ${spec} version`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === pkg.version;
} catch { /* not found */ }
if (published) {
  console.log(`${spec} is already published; nothing to do.`);
  process.exit(0);
}
execSync("pnpm build", { stdio: "inherit" });
execSync("npm publish --access public --provenance", { stdio: "inherit" });
// changesets/action pushes `<name>@<version>` (see the "New tag:" line below), so the tag must use that name.
execSync(`git tag ${spec}`, { stdio: "inherit" });
console.log(`New tag: ${spec}`);
