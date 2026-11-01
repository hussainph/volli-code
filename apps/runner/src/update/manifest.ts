/**
 * The runner release manifest (C4, `volli-runner-manifest.json`) as the
 * updater reads it, and the release origins it trusts URLs from.
 *
 * ```
 * { schemaVersion: 1, version, releaseTag, minRunnerVersion, minGlibc: "2.31",
 *   targets: [{ platform: "linux", arch: "x64" | "arm64", url, size, sha256 }],
 *   provenance: { bundleUrl } }
 * ```
 *
 * Strict on read, as the release workflow's manifest script (BYO-7) writes it:
 * an unknown field is drift, never ignored. Every URL in it must sit under a
 * trusted release origin, so a manifest cannot send the updater elsewhere; the
 * origin is the installer's (`--release-origin`, in the root-owned unit), never
 * the request's or the backend's.
 */
import { compareVersions } from "@volli/shared";

/** Where releases are published: the GitHub releases of the public repository. */
export const RELEASE_REPO = "hussainph/volli-code";
export const DEFAULT_RELEASE_ORIGIN = `https://github.com/${RELEASE_REPO}/releases/download/`;
export const MANIFEST_ASSET = "volli-runner-manifest.json";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** A release version, as the release feed accepts it (no leading `v`). */
export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && VERSION.test(value);
}

export type ReleaseArch = "x64" | "arm64";

export interface ReleaseTarget {
  readonly platform: "linux";
  readonly arch: ReleaseArch;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface RunnerReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly releaseTag: string;
  readonly minRunnerVersion: string;
  readonly minGlibc: string;
  readonly targets: readonly ReleaseTarget[];
  readonly provenance: { readonly bundleUrl: string };
}

/** Why an update was refused; `code` is what the outcome records. */
export class UpdateRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UpdateRefusal";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A release origin: an absolute URL prefix ending in `/`, https, or plain
 * http on loopback only (a test release server).
 */
export function parseReleaseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpdateRefusal("bad_origin", `${JSON.stringify(value)} is not a URL.`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new UpdateRefusal(
      "bad_origin",
      `A release origin is an https URL (http only on loopback), without credentials, a query or a fragment: ${value}`,
    );
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

/** `url`, if it is under one of `origins`; refused otherwise. */
export function trustedUrl(value: unknown, origins: readonly string[], what: string): string {
  let url: URL | null = null;
  try {
    url = typeof value === "string" && value.length <= 2048 ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (
    url === null ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !origins.some((origin) => url.href.startsWith(origin))
  ) {
    throw new UpdateRefusal(
      "untrusted_url",
      `The ${what} URL is not under a trusted release origin.`,
    );
  }
  return url.href;
}

/** The asset name of one target's tarball. */
export function tarballName(version: string, arch: ReleaseArch): string {
  return `volli-runner-${version}-linux-${arch}.tar.gz`;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdateRefusal("bad_manifest", `The manifest's ${what} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(row).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in row));
  if (extra.length > 0 || missing.length > 0) {
    throw new UpdateRefusal(
      "bad_manifest",
      `The manifest's ${what} does not match its schema (${[...extra.map((key) => `+${key}`), ...missing.map((key) => `-${key}`)].join(", ")}).`,
    );
  }
}

/**
 * Parses a manifest for `version`, with every URL under `origins`. Refuses a
 * manifest for another version: a request names the version it wants, and a
 * manifest URL cannot swap it.
 */
export function parseManifest(
  text: string,
  version: string,
  origins: readonly string[],
): RunnerReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpdateRefusal("bad_manifest", "The manifest is not JSON.");
  }
  const row = object(parsed, "document");
  exactKeys(
    row,
    [
      "schemaVersion",
      "version",
      "releaseTag",
      "minRunnerVersion",
      "minGlibc",
      "targets",
      "provenance",
    ],
    "document",
  );
  if (row.schemaVersion !== 1) {
    throw new UpdateRefusal("bad_manifest", "This runner reads manifest schema 1 only.");
  }
  if (row.version !== version || row.releaseTag !== `v${version}`) {
    throw new UpdateRefusal("wrong_version", `The manifest is not for ${version}.`);
  }
  if (
    !isReleaseVersion(row.minRunnerVersion) ||
    compareVersions(row.minRunnerVersion, version) > 0 ||
    typeof row.minGlibc !== "string" ||
    !/^\d+\.\d+$/u.test(row.minGlibc)
  ) {
    throw new UpdateRefusal("bad_manifest", "The manifest's floor or glibc baseline is invalid.");
  }
  if (!Array.isArray(row.targets) || row.targets.length === 0 || row.targets.length > 2) {
    throw new UpdateRefusal("bad_manifest", "The manifest's targets are invalid.");
  }
  const targets: ReleaseTarget[] = [];
  for (const item of row.targets) {
    const target = object(item, "target");
    exactKeys(target, ["platform", "arch", "url", "size", "sha256"], "target");
    if (
      target.platform !== "linux" ||
      (target.arch !== "x64" && target.arch !== "arm64") ||
      targets.some((other) => other.arch === target.arch) ||
      !Number.isSafeInteger(target.size) ||
      (target.size as number) <= 0 ||
      typeof target.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(target.sha256)
    ) {
      throw new UpdateRefusal("bad_manifest", "A manifest target is invalid.");
    }
    const url = trustedUrl(target.url, origins, "tarball");
    if (!url.endsWith(`/${tarballName(version, target.arch)}`)) {
      throw new UpdateRefusal("bad_manifest", "A manifest target names another release's tarball.");
    }
    targets.push({
      platform: "linux",
      arch: target.arch,
      url,
      size: target.size as number,
      sha256: target.sha256,
    });
  }
  const provenance = object(row.provenance, "provenance");
  exactKeys(provenance, ["bundleUrl"], "provenance");
  return {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion: row.minRunnerVersion,
    minGlibc: row.minGlibc,
    targets,
    provenance: { bundleUrl: trustedUrl(provenance.bundleUrl, origins, "provenance bundle") },
  };
}

/** This box's target, or a refusal naming the arch the release lacks. */
export function targetFor(manifest: RunnerReleaseManifest, arch: string): ReleaseTarget {
  const target = manifest.targets.find((entry) => entry.arch === arch);
  if (target === undefined) {
    throw new UpdateRefusal("no_target", `Release ${manifest.version} has no linux-${arch} build.`);
  }
  return target;
}
