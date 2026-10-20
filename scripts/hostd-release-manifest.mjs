#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Every release carries exactly these hostd targets, in this order (Linux
// first, as it shipped first). The desktop's artifact parser derives a target
// from each asset's name, so a target added here flows through to it.
export const targets = Object.freeze([
  Object.freeze({ platform: "linux", arch: "x64" }),
  Object.freeze({ platform: "linux", arch: "arm64" }),
  Object.freeze({ platform: "darwin", arch: "arm64" }),
  Object.freeze({ platform: "darwin", arch: "x64" }),
]);
const targetList = targets.map(({ platform, arch }) => `${platform} ${arch}`).join(", ");

export function releaseVersion(root = repositoryRoot) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const desktopVersion = JSON.parse(
    readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
  ).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (version !== desktopVersion) {
    throw new Error(
      `Version drift: root package.json is ${version} but apps/desktop/package.json is ${desktopVersion} — bump both together.`,
    );
  }
  return version;
}

function assetName(version, { platform, arch }) {
  return `volli-hostd-${version}-${platform}-${arch}.tar.gz`;
}

// Shared by generation and desktop copying: release inputs must contain every
// exact-version target above. An empty local manifest is never a release input.
export function validateReleaseManifest(manifest, version) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.version !== version ||
    manifest.releaseTag !== `v${version}`
  ) {
    throw new Error("Hostd manifest schema/version/releaseTag mismatch");
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== targets.length) {
    throw new Error(`Hostd manifest requires exactly these assets: ${targetList}`);
  }
  const assets = targets.map((target) => {
    const { platform, arch } = target;
    const matches = manifest.assets.filter(
      (entry) => entry?.platform === platform && entry?.arch === arch,
    );
    const asset = matches.length === 1 ? matches[0] : undefined;
    if (
      asset === undefined ||
      asset.name !== assetName(version, target) ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      throw new Error(`Invalid hostd manifest asset: ${platform} ${arch}`);
    }
    if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size <= 0)) {
      throw new Error(`Invalid hostd asset size: ${asset.name}`);
    }
    return {
      platform,
      arch,
      name: asset.name,
      sha256: asset.sha256,
      ...(asset.size === undefined ? {} : { size: asset.size }),
    };
  });
  return { schemaVersion: 1, version, releaseTag: `v${version}`, assets };
}

export async function generateHostdReleaseManifest(assetsDir, root = repositoryRoot) {
  const version = releaseVersion(root);
  const names = targets.map((target) => assetName(version, target));
  const required = names.flatMap((name) => [name, `${name}.sha256`]);
  const allowed = new Set([...required, "SHA256SUMS", "hostd-release-manifest.json"]);
  const entries = readdirSync(assetsDir);
  for (const name of entries) {
    if (!allowed.has(name)) throw new Error(`Unexpected release asset: ${name}`);
    if (!lstatSync(join(assetsDir, name)).isFile()) {
      throw new Error(`Release asset must be a regular file: ${name}`);
    }
  }
  for (const name of required) {
    if (!entries.includes(name)) throw new Error(`Missing release asset: ${name}`);
  }
  const assets = [];
  for (const [index, name] of names.entries()) {
    const sidecar = readFileSync(join(assetsDir, `${name}.sha256`), "utf8");
    const match = /^([0-9a-f]{64})  ([^\r\n]+)\n?$/.exec(sidecar);
    if (!match || match[2] !== name) throw new Error(`Invalid checksum sidecar: ${name}.sha256`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(join(assetsDir, name))) {
      hash.update(chunk);
      size += chunk.length;
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== match[1]) throw new Error(`SHA256 mismatch: ${name}`);
    assets.push({ ...targets[index], name, sha256, size });
  }
  const manifest = validateReleaseManifest(
    { schemaVersion: 1, version, releaseTag: `v${version}`, assets },
    version,
  );
  // Do not emit either output until every input has passed validation.
  writeFileSync(
    join(assetsDir, "SHA256SUMS"),
    assets.map(({ sha256, name }) => `${sha256}  ${name}\n`).join(""),
  );
  writeFileSync(
    join(assetsDir, "hostd-release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { assets: { type: "string" } } });
    if (!values.assets)
      throw new Error("Usage: node scripts/hostd-release-manifest.mjs --assets <folder>");
    await generateHostdReleaseManifest(resolve(values.assets));
    console.log("Validated hostd release assets; wrote SHA256SUMS and hostd-release-manifest.json");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
