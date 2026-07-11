#!/usr/bin/env node
// Build the VM-Poppy backend into a single self-contained executable the host spawns.
//
// v1: esbuild-bundle the TS backend (with the AWS SDK inlined) into one .mjs with a
// Node shebang, chmod +x, named `backend/vmpoppy-sidecar`. Runs as an executable on
// any machine with Node. (Distribution hardening — a Node SEA so end users need no
// Node — mirrors MailPoppy's build-sidecar and is a later step; see DESIGN.md §13.)

import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "backend/src/server.ts");
const outFile = join(root, "backend/vmpoppy-sidecar");

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});

// Preserve the shebang esbuild may reorder, then make it executable.
const built = readFileSync(outFile, "utf8");
if (!built.startsWith("#!")) writeFileSync(outFile, `#!/usr/bin/env node\n${built}`);
chmodSync(outFile, 0o755);
console.log(`[build-sidecar] wrote ${outFile}`);
