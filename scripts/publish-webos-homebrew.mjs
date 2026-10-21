// Publishes the current webOS build of the fork to its Homebrew Channel repository.
//
// 1. builds + packages com.marlon.nuvio_<version>_all.ipk
// 2. uploads it as a GitHub release asset on the fork
// 3. rewrites apps.json on the orphan `webosbrew` branch (via the GitHub API)
//
// Homebrew Channel only offers an update when the version in package.json is
// higher than the one already published, so bump it before running this.
//
// Usage: node scripts/publish-webos-homebrew.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppMetadata } from "./appMetadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const repo = "MarlonH1/NuvioTVSmart";
const branch = "webosbrew";
const appId = "com.marlon.nuvio";
const title = "Nuvio TV (Marlon)";
const description = "Nuvio TV fork with Nuvio Remote support.";
const rawBase = `https://raw.githubusercontent.com/${repo}/${branch}`;

const dryRun = process.argv.includes("--dry-run");

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit", ...options });
}

function gh(args, input) {
  return execFileSync("gh", args, {
    cwd: rootDir,
    encoding: "utf8",
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"]
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function readBranchFile(name) {
  try {
    const res = JSON.parse(gh(["api", `repos/${repo}/contents/${name}?ref=${branch}`]));
    return { sha: res.sha, content: Buffer.from(res.content, "base64") };
  } catch {
    return null;
  }
}

function putBranchFile(name, content, message, sha) {
  const body = JSON.stringify({
    message,
    branch,
    content: Buffer.from(content).toString("base64"),
    ...(sha ? { sha } : {})
  });
  gh(["api", "-X", "PUT", `repos/${repo}/contents/${name}`, "--input", "-"], body);
}

function ensureBranch() {
  try {
    gh(["api", `repos/${repo}/branches/${branch}`]);
    return;
  } catch {
    // Create an orphan branch: an empty tree + root commit, then the ref.
  }
  const tree = JSON.parse(
    gh(
      ["api", "-X", "POST", `repos/${repo}/git/trees`, "--input", "-"],
      JSON.stringify({
        tree: [
          {
            path: "README.md",
            mode: "100644",
            type: "blob",
            content: `Homebrew Channel repository for ${appId}.\n\nAdd \`${rawBase}/apps.json\` under Homebrew Channel → Settings → Extra repositories.\n`
          }
        ]
      })
    )
  ).sha;
  const commit = JSON.parse(
    gh(
      ["api", "-X", "POST", `repos/${repo}/git/commits`, "--input", "-"],
      JSON.stringify({ message: "Init Homebrew Channel repository", tree, parents: [] })
    )
  ).sha;
  gh(
    ["api", "-X", "POST", `repos/${repo}/git/refs`, "--input", "-"],
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit })
  );
  console.log(`Created branch ${branch}`);
}

const { version } = await readAppMetadata();
const tag = `webos-v${version}`;

const existing = readBranchFile("apps.json");
const publishedVersion = existing
  ? JSON.parse(existing.content.toString("utf8")).packages?.[0]?.manifest?.version
  : null;
if (publishedVersion && compareVersions(version, publishedVersion) <= 0) {
  console.error(
    `package.json version ${version} is not higher than the published ${publishedVersion}. ` +
      `Bump "version" in package.json first, otherwise Homebrew Channel won't offer the update.`
  );
  process.exit(1);
}

run(process.execPath, ["scripts/build.mjs"]);
run(process.execPath, ["scripts/package-webos.mjs"]);

const ipkPath = path.join(rootDir, `${appId}_${version}_all.ipk`);
const ipk = await readFile(ipkPath);
const sha256 = createHash("sha256").update(ipk).digest("hex");
const assetName = `NuvioTV-webOS-${version}.ipk`;

const manifest = {
  id: appId,
  version,
  type: "web",
  title,
  appDescription: description,
  iconUri: `${rawBase}/icon.png`,
  sourceUrl: `https://github.com/${repo}`,
  rootRequired: false,
  ipkUrl: `https://github.com/${repo}/releases/download/${tag}/${assetName}`,
  ipkHash: { sha256 },
  ipkSize: ipk.length
};
const appsJson = {
  paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1 },
  packages: [
    {
      id: appId,
      title,
      iconUri: manifest.iconUri,
      manifest,
      pool: "main",
      shortDescription: description
    }
  ]
};

console.log(`\n${assetName}: ${ipk.length} bytes, sha256 ${sha256}`);
if (dryRun) {
  console.log("\n--dry-run: nothing uploaded. apps.json would be:\n");
  console.log(JSON.stringify(appsJson, null, 2));
  process.exit(0);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
run("gh", [
  "release",
  "create",
  tag,
  `${ipkPath}#${assetName}`,
  "--repo",
  repo,
  "--target",
  head,
  "--title",
  `webOS ${version}`,
  "--notes",
  `webOS build ${version} of ${appId} (commit ${head.slice(0, 7)}).`,
  "--latest=false"
]);

ensureBranch();
if (!readBranchFile("icon.png")) {
  putBranchFile(
    "icon.png",
    await readFile(path.join(rootDir, "assets", "images", "icon.png")),
    "Add icon"
  );
}
putBranchFile(
  "apps.json",
  `${JSON.stringify(appsJson, null, 2)}\n`,
  `Publish ${appId} ${version}`,
  readBranchFile("apps.json")?.sha
);

console.log(`\nPublished ${version}. Homebrew Channel repo: ${rawBase}/apps.json`);
