#!/usr/bin/env node
/**
 * The runner's release asset set: the two Linux tarballs, the stamped
 * installer, one manifest that describes them, and the checksums that cover
 * the set. The installer and the updater read that manifest; it is C4:
 *
 *   {
 *     schemaVersion: 1, version, releaseTag, minRunnerVersion,
 *     minGlibc: "2.31",
 *     targets: [{ platform: "linux", arch: "x64" | "arm64", url, size, sha256 }],
 *     provenance: { bundleUrl }
 *   }
 *
 * `url` is absolute, so a target can be fetched from its manifest entry alone.
 * The prefix is the containing release,
 * `https://github.com/hussainph/volli-code/releases/download/v<version>`,
 * unless `--release-base` names another one: mirrors, and local test servers
 * where plain http is accepted on loopback only, since a shipped manifest never
 * downgrades to http.
 *
 * `minRunnerVersion` is the upgrade floor: the oldest runner the backend still
 * accepts, so a runner below it must update before it can run. It is not a
 * floor on which runner can apply an update — any runner may download these
 * assets; an older one updates to reach the floor. It defaults to this
 * release's own version and is never newer than it, since the release's own
 * runner has to satisfy the floor it publishes.
 *
 * `minGlibc` is the baseline the artifacts were built and probed against.
 *
 * The checksum file covers the tarballs, the installer and the manifest, and
 * deliberately not the provenance bundle: the Sigstore attestation signs these
 * very bytes after this script runs, so checksumming it here would be a cycle.
 *
 * The manifest is exhaustive on write and strict on read: it is generated,
 * never hand-edited, so an unknown field is schema drift and a newer shape
 * arrives as a new `schemaVersion`. Nothing imports this module at runtime —
 * the updater reads the published file, not a release-build script.
 *
 * Usage: node scripts/runner-release-manifest.mjs --assets <folder>
 *          [--release-base <url>] [--min-runner-version <version>]
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { releaseVersion, repositoryRoot } from "./hostd-release-manifest.mjs";

// Every runner release carries exactly these targets, in this order. The
// updater picks one by platform and arch, so an extra, missing or misnamed
// target is an asset set we did not build and must not publish.
export const runnerTargets = Object.freeze([
  Object.freeze({ platform: "linux", arch: "x64" }),
  Object.freeze({ platform: "linux", arch: "arm64" }),
]);
const targetList = runnerTargets.map(({ platform, arch }) => `${platform} ${arch}`).join(", ");

// The glibc floor the build image compiles and probes against. Changing the
// baseline is a schema change, not a per-release flag: a consumer compares its
// own glibc against this one value.
export const minGlibc = "2.31";

// The installer template in the tree, stamped with the release version on the
// way into the asset set. The placeholder is the only thing the packaging
// script may leave unresolved.
export const installerTemplatePath = "apps/runner/packaging/install.sh";
export const installerVersionPlaceholder = "@VOLLI_RUNNER_VERSION@";

export const manifestName = "volli-runner-manifest.json";
export const checksumsName = "volli-runner-SHA256SUMS";
export const installerName = "volli-runner-install.sh";
export const provenanceName = "volli-runner-provenance.sigstore.json";

// The public release origin. A release lives at <origin>/v<version>, which is
// what the default absolute prefix of every target URL is.
const defaultReleaseOrigin = "https://github.com/hussainph/volli-code/releases/download";

const manifestFields = [
  "schemaVersion",
  "version",
  "releaseTag",
  "minRunnerVersion",
  "minGlibc",
  "targets",
  "provenance",
];
const targetFields = ["platform", "arch", "url", "size", "sha256"];
const provenanceFields = ["bundleUrl"];
// The shape the repository's versions use (root and desktop package.json),
// kept identical to the hostd manifest helper's so one release has one
// spelling of its version. Safety on top of the shape is checked below.
const safeVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const sidecarPattern = /^([0-9a-f]{64})  ([^\r\n]+)\n?$/;
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function runnerAssetName(version, { platform, arch }) {
  return `volli-runner-${version}-${platform}-${arch}.tar.gz`;
}

/** The default absolute prefix of a release's assets: its own public tag URL. */
export function defaultReleaseBase(version) {
  return `${defaultReleaseOrigin}/v${version}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFields(value, fields, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`Unexpected field in ${label}: ${key}`);
  }
  for (const key of fields) {
    if (!(key in value)) throw new Error(`Missing field in ${label}: ${key}`);
  }
}

// A version ends up in an asset filename and in a URL path. The shape check
// rejects anything a shell, a filename or a URL path could read as more than a
// version — traversal, separators, whitespace, an empty segment.
function assertSafeVersion(value, label) {
  if (
    typeof value !== "string" ||
    !safeVersion.test(value) ||
    value.includes("..") ||
    value.endsWith(".")
  ) {
    throw new Error(
      `Unsafe ${label}: ${JSON.stringify(value)} (expected X.Y.Z or X.Y.Z-prerelease)`,
    );
  }
  return value;
}

function versionParts(version) {
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  const prerelease = dash === -1 ? "" : version.slice(dash + 1);
  return { core: core.split(".").map(Number), prerelease: prerelease.split(".").filter(Boolean) };
}

/** Compare two safe versions by semver precedence: negative when a < b. */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^[0-9]+$/.test(x);
    const yNumeric = /^[0-9]+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The absolute prefix every URL in a manifest shares. https, or plain http on
 * loopback only (a local test server), and never a URL that carries credentials,
 * a query or a fragment: the prefix is joined with an asset name, nothing else.
 */
function normalizeReleaseBase(base) {
  if (typeof base !== "string" || base.trim() === "" || /\s/.test(base)) {
    throw new Error(`Invalid release base: ${JSON.stringify(base)}`);
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`Release base must be an absolute URL: ${base}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Release base must not carry credentials: ${base}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`Release base must not carry a query or fragment: ${base}`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopbackHostnames.has(url.hostname))
  ) {
    throw new Error(`Release base must be https (http only on localhost): ${base}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function assetUrl(base, name) {
  return `${base}/${name}`;
}

// A target URL names an asset inside the release prefix. Splitting the name
// back off proves both: the entry points at this exact asset, and every entry
// (and the provenance bundle) belongs to one release.
function baseOfAssetUrl(url, name, label) {
  const suffix = `/${name}`;
  if (typeof url !== "string" || !url.endsWith(suffix)) {
    throw new Error(`${label} URL must end with ${suffix}: ${JSON.stringify(url)}`);
  }
  return normalizeReleaseBase(url.slice(0, -suffix.length));
}

/**
 * The normalized manifest, or a thrown error naming what is wrong with it.
 *
 * `releaseBase`, when given, pins the prefix: a published manifest that points
 * at a different release than the one being assembled is rejected rather than
 * written.
 */
export function validateRunnerReleaseManifest(manifest, version, { releaseBase } = {}) {
  assertSafeVersion(version, "release version");
  assertFields(manifest, manifestFields, "runner manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Runner manifest schemaVersion must be 1, not ${manifest.schemaVersion}`);
  }
  if (manifest.version !== version) {
    throw new Error(`Runner manifest version ${manifest.version} is not ${version}`);
  }
  if (manifest.releaseTag !== `v${version}`) {
    throw new Error(`Runner manifest releaseTag ${manifest.releaseTag} is not v${version}`);
  }
  assertSafeVersion(manifest.minRunnerVersion, "minRunnerVersion");
  if (compareVersions(manifest.minRunnerVersion, version) > 0) {
    throw new Error(
      `minRunnerVersion ${manifest.minRunnerVersion} is newer than the release ${version}; the upgrade floor would refuse this release's own runner`,
    );
  }
  if (manifest.minGlibc !== minGlibc) {
    throw new Error(`Runner manifest minGlibc must be ${minGlibc}, not ${manifest.minGlibc}`);
  }

  if (!Array.isArray(manifest.targets) || manifest.targets.length !== runnerTargets.length) {
    throw new Error(`Runner manifest requires exactly these targets: ${targetList}`);
  }
  const byArch = new Map();
  for (const entry of manifest.targets) {
    assertFields(entry, targetFields, "runner target");
    if (entry.platform !== "linux") {
      throw new Error(`Runner target platform must be linux, not ${entry.platform}`);
    }
    if (!runnerTargets.some(({ arch }) => arch === entry.arch)) {
      throw new Error(`Unexpected runner target arch: ${entry.arch}`);
    }
    if (byArch.has(entry.arch)) throw new Error(`Duplicate runner target: linux ${entry.arch}`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`Invalid runner target size: ${entry.arch} ${entry.size}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid runner target sha256: ${entry.arch} ${entry.sha256}`);
    }
    byArch.set(entry.arch, entry);
  }

  const expectedBase = releaseBase === undefined ? undefined : normalizeReleaseBase(releaseBase);
  let base;
  const targets = runnerTargets.map(({ platform, arch }) => {
    const entry = byArch.get(arch);
    if (entry === undefined) throw new Error(`Missing runner target: linux ${arch}`);
    const name = runnerAssetName(version, { platform, arch });
    const targetBase = baseOfAssetUrl(entry.url, name, `runner ${arch} target`);
    if (base === undefined) {
      base = targetBase;
    } else if (targetBase !== base) {
      throw new Error(`Runner target ${arch} points at ${targetBase}, not the release at ${base}`);
    }
    return {
      platform,
      arch,
      url: assetUrl(targetBase, name),
      size: entry.size,
      sha256: entry.sha256,
    };
  });
  if (expectedBase !== undefined && base !== expectedBase) {
    throw new Error(`Runner manifest points at ${base}, not the release base ${expectedBase}`);
  }

  assertFields(manifest.provenance, provenanceFields, "runner manifest provenance");
  const bundleUrl = assetUrl(base, provenanceName);
  if (manifest.provenance.bundleUrl !== bundleUrl) {
    throw new Error(
      `Runner provenance bundleUrl must be ${bundleUrl}, not ${manifest.provenance.bundleUrl}`,
    );
  }

  return {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion: manifest.minRunnerVersion,
    minGlibc,
    targets,
    provenance: { bundleUrl },
  };
}

async function digestFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The installer that ships beside the tarballs is the tree's template with the
// release version stamped into it. A template with no placeholder would ship
// an installer that cannot name the release it installs, so that is an error
// rather than a warning.
function readInstallerTemplate(templatePath, version) {
  if (!existsSync(templatePath)) {
    throw new Error(`Missing runner installer template: ${templatePath}`);
  }
  const template = readFileSync(templatePath, "utf8");
  if (!template.includes(installerVersionPlaceholder)) {
    throw new Error(
      `Runner installer template has no ${installerVersionPlaceholder}: ${templatePath}`,
    );
  }
  return template.replaceAll(installerVersionPlaceholder, version);
}

/**
 * Validate the inputs in `assetsDir`, then write the installer, the manifest
 * and the checksums into it, and return the normalized manifest.
 *
 * Nothing is written until every input has passed: a release asset set is
 * either complete and self-consistent or absent.
 */
export async function generateRunnerReleaseManifest(assetsDir, options = {}) {
  const {
    root = repositoryRoot,
    releaseBase,
    minRunnerVersion,
    installerTemplate = join(root, installerTemplatePath),
  } = options;

  // Root and desktop versions are bumped together (hostd manifest helper), so
  // one release has one version and one tag.
  const version = assertSafeVersion(releaseVersion(root), "release version");
  const base = normalizeReleaseBase(releaseBase ?? defaultReleaseBase(version));
  const minVersion = assertSafeVersion(minRunnerVersion ?? version, "minRunnerVersion");
  if (compareVersions(minVersion, version) > 0) {
    throw new Error(
      `minRunnerVersion ${minVersion} is newer than the release ${version}; the upgrade floor would refuse this release's own runner`,
    );
  }

  if (!existsSync(assetsDir) || !lstatSync(assetsDir).isDirectory()) {
    throw new Error(`Missing runner assets folder: ${assetsDir}`);
  }
  const names = runnerTargets.map((target) => runnerAssetName(version, target));
  const required = names.flatMap((name) => [name, `${name}.sha256`]);
  // The three outputs may already be here (a re-run rewrites them), and so may
  // the provenance bundle, which the release signs after this step and which
  // is deliberately not checksummed.
  const allowed = new Set([
    ...required,
    manifestName,
    checksumsName,
    installerName,
    provenanceName,
  ]);
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

  const targets = [];
  for (const [index, name] of names.entries()) {
    const sidecar = readFileSync(join(assetsDir, `${name}.sha256`), "utf8");
    const match = sidecarPattern.exec(sidecar);
    if (!match || match[2] !== name) throw new Error(`Invalid checksum sidecar: ${name}.sha256`);
    const { sha256, size } = await digestFile(join(assetsDir, name));
    if (sha256 !== match[1]) throw new Error(`SHA256 mismatch: ${name}`);
    targets.push({ ...runnerTargets[index], url: assetUrl(base, name), size, sha256 });
  }

  const manifest = validateRunnerReleaseManifest(
    {
      schemaVersion: 1,
      version,
      releaseTag: `v${version}`,
      minRunnerVersion: minVersion,
      minGlibc,
      targets,
      provenance: { bundleUrl: assetUrl(base, provenanceName) },
    },
    version,
    { releaseBase: base },
  );

  const installer = readInstallerTemplate(installerTemplate, version);
  const installerBytes = Buffer.from(installer, "utf8");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const checksums = [
    ...manifest.targets.map((target) => [
      target.sha256,
      target.url.slice(target.url.lastIndexOf("/") + 1),
    ]),
    [digestBytes(installerBytes), installerName],
    [digestBytes(manifestBytes), manifestName],
  ];

  writeFileSync(join(assetsDir, installerName), installerBytes);
  chmodSync(join(assetsDir, installerName), 0o755);
  writeFileSync(join(assetsDir, manifestName), manifestBytes);
  writeFileSync(
    join(assetsDir, checksumsName),
    checksums.map(([sha256, name]) => `${sha256}  ${name}\n`).join(""),
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        assets: { type: "string" },
        "release-base": { type: "string" },
        "min-runner-version": { type: "string" },
      },
    });
    if (!values.assets) {
      throw new Error(
        "Usage: node scripts/runner-release-manifest.mjs --assets <folder> [--release-base <url>] [--min-runner-version <version>]",
      );
    }
    const manifest = await generateRunnerReleaseManifest(resolve(values.assets), {
      ...(values["release-base"] === undefined ? {} : { releaseBase: values["release-base"] }),
      ...(values["min-runner-version"] === undefined
        ? {}
        : { minRunnerVersion: values["min-runner-version"] }),
    });
    console.log(
      `Wrote ${manifestName}, ${checksumsName} and ${installerName} for ${manifest.releaseTag} (min runner ${manifest.minRunnerVersion}, glibc >= ${manifest.minGlibc})`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
