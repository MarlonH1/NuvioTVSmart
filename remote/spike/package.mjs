// Packages the spike as its own IPK (space.nuvio.remotespike_<v>_all.ipk).
// Uses the repo's @webos-tools/cli devDependency (run `npm install` once),
// or a globally installed `ares-package` as fallback.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist");
mkdirSync(outDir, { recursive: true });
const args = [path.join(here, "app"), path.join(here, "service"), "--outdir", outDir];

let ok = false;
try {
  const { runWebOsToolsBinary } = await import("../../scripts/aresCli.mjs");
  await runWebOsToolsBinary("ares-package", args);
  ok = true;
} catch (error) {
  console.warn(`repo ares-package unavailable (${error.message}); trying global ares-package`);
  ok = spawnSync("ares-package", args, { stdio: "inherit" }).status === 0;
}
if (!ok) process.exit(1);
console.log(`\nIPK written to ${outDir}`);
