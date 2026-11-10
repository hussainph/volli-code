// The release workflow calls prepare before building, then upload only after
// signing, stapling and the local artifact gates. Nothing reads a draft through
// the public updater feed. Keep every destructive upload behind that boundary.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function gh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    timeout: 10 * 60_000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.error || result.status}`,
    );
  }
  return result.stdout;
}

async function digest(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm === "sha512" ? "base64" : "hex");
}

const [command, directory, ...files] = process.argv.slice(2);
const tag = process.env.REF_NAME;
const repo = process.env.GITHUB_REPOSITORY;
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
  throw new Error("REF_NAME must be a release version tag");
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  throw new Error("GITHUB_REPOSITORY must name owner/repository");
}
const prerelease = tag.includes("-");
const endpoint = `repos/${repo}/releases`;

function releaseForTag() {
  // Unlike a failed tag lookup, an empty successful list distinguishes absence
  // from a permissions/transport error. Paginate so an old draft is reusable.
  const output = gh([
    "api",
    "--paginate",
    `${endpoint}?per_page=100`,
    "--jq",
    `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {tag_name, draft, prerelease, assets: [.assets[] | {name}]}`,
  ]);
  return output.trim() ? JSON.parse(output) : undefined;
}

function checkChannel(release) {
  if (release.prerelease !== prerelease) {
    throw new Error(`${tag} has the wrong prerelease flag; refusing to change its channel`);
  }
}

async function checkFeed(assets) {
  // Loaded only in upload, after the workflow's locked install. prepare runs
  // before that install and needs only Node and gh.
  const { parse } = await import("yaml");
  const feed = parse(await readFile(join(assets, "latest-mac.yml"), "utf8"));
  if (feed?.version !== tag.slice(1) || !Array.isArray(feed.files)) {
    throw new Error("latest-mac.yml has the wrong version or no files");
  }
  const desktop = files.filter((name) => name.endsWith(".dmg") || name.endsWith("-mac.zip"));
  if (
    desktop.length !== 2 ||
    !desktop.some((name) => name.endsWith(".dmg")) ||
    feed.files.length !== 2
  ) {
    throw new Error("latest-mac.yml must describe exactly the DMG and auto-update ZIP");
  }
  for (const name of desktop) {
    const entry = feed.files.find((file) => file.url === name);
    if (
      !entry ||
      entry.sha512 !== (await digest(join(assets, name), "sha512")) ||
      entry.size !== (await stat(join(assets, name))).size
    ) {
      throw new Error(`latest-mac.yml does not describe the completed artifact: ${name}`);
    }
  }
  const zip = feed.files.find((file) => file.url.endsWith("-mac.zip"));
  if (feed.path !== zip.url || feed.sha512 !== zip.sha512) {
    throw new Error("latest-mac.yml legacy ZIP fields disagree with its files");
  }
}

async function verifyRemote(assets) {
  const scratch = await mkdtemp(join(assets, ".verify-release-"));
  try {
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--dir",
      scratch,
      ...files.flatMap((file) => ["--pattern", file]),
    ]);
    for (const file of files) {
      if (
        (await digest(join(scratch, file), "sha256")) !==
        (await digest(join(assets, file), "sha256"))
      ) {
        throw new Error(`uploaded asset differs from the completed local artifact: ${file}`);
      }
    }
    console.log(`Verified downloaded bytes for all ${files.length} release assets`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyPublicFeed(assets) {
  const expected = await readFile(join(assets, "latest-mac.yml"));
  const url = `https://github.com/${repo}/releases/download/${tag}/latest-mac.yml`;
  // A short bounded retry covers GitHub's publication propagation, not missing
  // uploads. No Authorization header: this is the URL the updater can read.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!expected.equals(Buffer.from(await response.arrayBuffer()))) {
        throw new Error("public feed differs from the verified upload");
      }
      console.log(`Verified unauthenticated updater feed: ${url}`);
      return;
    } catch (error) {
      if (attempt === 5)
        throw new Error(`Published release has an unreadable updater feed: ${error.message}`, {
          cause: error,
        });
      await delay(3_000);
    }
  }
}

if (command === "prepare" && !directory) {
  const existing = releaseForTag();
  if (existing) {
    checkChannel(existing);
    console.log(
      `${tag} already exists (${existing.draft ? "draft" : "published; uploads will be verification-only"})`,
    );
  } else {
    gh(
      ["api", "--method", "POST", endpoint, "--input", "-"],
      JSON.stringify({
        tag_name: tag,
        name: tag.slice(1),
        draft: true,
        prerelease,
      }),
    );
    console.log(`Created draft for ${tag}`);
  }
} else if (command === "upload" && directory && files.length) {
  const assets = resolve(directory);
  if (
    new Set(files).size !== files.length ||
    !files.includes("latest-mac.yml") ||
    files.some((file) => basename(file) !== file || !/^[\w.-]+$/.test(file))
  ) {
    throw new Error("Expected unique release asset basenames, including latest-mac.yml");
  }
  for (const file of files) {
    if (!(await stat(join(assets, file))).isFile() || (await stat(join(assets, file))).size === 0) {
      throw new Error(`Release asset missing or empty: ${file}`);
    }
  }
  await checkFeed(assets);
  const release = releaseForTag();
  if (!release) throw new Error(`No prepared release for ${tag}`);
  checkChannel(release);
  if (release.draft) {
    for (const asset of release.assets) {
      // Advisory capture is deliberately outside the critical publication set.
      if (!files.includes(asset.name) && asset.name !== "canary-peer.json") {
        gh(["release", "delete-asset", tag, asset.name, "--repo", repo, "--yes"]);
      }
    }
    gh([
      "release",
      "upload",
      tag,
      ...files.map((file) => join(assets, file)),
      "--repo",
      repo,
      "--clobber",
    ]);
  }
  // A rerun of a published tag never clobbers live assets. Identical inputs
  // verify idempotently; a rebuilt/different artifact requires a new version.
  await verifyRemote(assets);
  if (release.draft && prerelease) {
    gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease"]);
    console.log(`Published verified prerelease ${tag}`);
  }
  if (!release.draft || prerelease) await verifyPublicFeed(assets);
  else console.log(`Verified stable draft ${tag}; publish manually after reviewing notes`);
} else {
  throw new Error(
    "Usage: node scripts/release-publication.mjs prepare | upload <directory> <asset>...",
  );
}
