/**
 * The hostd tarball (VC-700 flow step 4): exactly this app's version, for
 * the box's architecture, cached on the Mac and uploaded from it, so the box
 * needs no route to our releases.
 *
 * **The trust root is the pin inside the signed app** (VC-701's
 * `hostd-release-manifest.json`, copied into the app at build): the version,
 * each asset's name and its SHA-256. A release download is checked against
 * that pin and nothing else. A `SHA256SUMS` or `.sha256` downloaded beside the
 * asset is never trusted: whoever could swap the tarball could swap those.
 *
 * Where the tarball comes from:
 * 1. **A pinned release** (`pin` has an asset for the target): the cache at
 *    `<cacheDir>/<version>/<name>` if its digest still matches the pin, else
 *    `<releaseBase>/<releaseTag>/<name>`, downloaded and checked before it is
 *    kept.
 * 2. **No release assets** (the manifest is missing, as in `vp dev`, or has
 *    `assets: []`, as local and CI builds do): only the dev source, local
 *    tarballs as `gh run download … -n volli-hostd-linux-x64` (or a Mac's
 *    `node apps/hostd/scripts/package.mjs`) leaves them, each checked
 *    against its own `.sha256` (dev builds only, the owner's 2026-10-07
 *    allowance: it guards against a torn copy, not a forger).
 *
 * **What a build can install** (`supportedTargets`) follows from the same
 * sources: the pinned assets' targets (VC-701's manifest carries linux and,
 * from VC-700 PR 1c, darwin, each x64 and arm64), else the dev tarballs'.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import type { InstallLogger } from "./logger";

export const RELEASE_BASE_URL = "https://github.com/hussainph/volli-code/releases/download";

/** Targets a dev build can install from a local tarball: the CI artifact's. */
export const DEFAULT_SUPPORTED_TARGETS: readonly string[] = ["linux-x64"];

/** One pinned asset, as VC-701's manifest names it. */
export interface PinnedAsset {
  readonly target: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number | null;
}

/** The signed app's hostd pin. `assets` is empty in local and CI builds. */
export interface HostdReleasePin {
  readonly version: string;
  readonly releaseTag: string;
  readonly assets: readonly PinnedAsset[];
}

/**
 * VC-701's manifest (`schemaVersion: 1`), or `null` for one that is missing
 * or not well formed: either way, no release assets. An asset whose name is
 * not this version's tarball is dropped rather than trusted.
 */
export function parseHostdReleasePin(value: unknown): HostdReleasePin | null {
  if (typeof value !== "object" || value === null) return null;
  const manifest = value as Record<string, unknown>;
  const { version } = manifest;
  if (
    manifest.schemaVersion !== 1 ||
    typeof version !== "string" ||
    manifest.releaseTag !== `v${version}` ||
    !Array.isArray(manifest.assets)
  ) {
    return null;
  }
  const assets: PinnedAsset[] = [];
  for (const entry of manifest.assets as unknown[]) {
    const asset = (entry ?? {}) as Record<string, unknown>;
    const target = `${String(asset.platform)}-${String(asset.arch)}`;
    if (
      asset.name !== artifactFileName(version, target) ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256)
    ) {
      continue;
    }
    assets.push({
      target,
      name: asset.name,
      sha256: asset.sha256,
      size: typeof asset.size === "number" ? asset.size : null,
    });
  }
  return { version, releaseTag: `v${version}`, assets };
}

/**
 * The targets this build can install: the pinned assets', or, with none
 * pinned, the dev tarballs' (named `volli-hostd-<version>-<target>.tar.gz`),
 * or the CI artifact's when no dev tarball is named either.
 */
export function supportedTargets(
  pin: HostdReleasePin | null,
  devTarballs: readonly string[] = [],
): readonly string[] {
  if (pin !== null && pin.assets.length > 0) return pin.assets.map((asset) => asset.target);
  const dev = [
    ...new Set(
      devTarballs.flatMap((path) => {
        const target = /^volli-hostd-.+-((?:linux|darwin)-(?:x64|arm64))\.tar\.gz$/u.exec(
          basename(path),
        )?.[1];
        return target === undefined ? [] : [target];
      }),
    ),
  ];
  return dev.length > 0 ? dev : DEFAULT_SUPPORTED_TARGETS;
}

export interface HostdArtifact {
  readonly version: string;
  readonly target: string;
  readonly fileName: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source: "dev" | "cache" | "release";
}

export type ArtifactFailure =
  | { readonly kind: "artifact-unavailable"; readonly detail: string }
  | { readonly kind: "artifact-checksum"; readonly detail: string }
  | { readonly kind: "artifact-fetch-failed"; readonly detail: string };

export function artifactFileName(version: string, target: string): string {
  return `volli-hostd-${version}-${target}.tar.gz`;
}

/** The hex digest a `sha256sum` line starts with, or `null`. */
export function parseChecksum(text: string): string | null {
  const digest = /^([0-9a-f]{64})\b/iu.exec(text.trim())?.[1];
  return digest === undefined ? null : digest.toLowerCase();
}

/** A file's digest, or `null` when it cannot be read. */
export async function sha256File(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(path), hash);
  } catch {
    return null;
  }
  return hash.digest("hex");
}

export interface ArtifactRequest {
  readonly version: string;
  readonly target: string;
  readonly cacheDir: string;
  /** The signed app's pin; `null` when the build has none (dev). */
  readonly pin: HostdReleasePin | null;
  /** Dev builds without release assets: local tarballs, each `.sha256` beside it; the one named for the target is used. */
  readonly devTarballs?: readonly string[];
  readonly releaseBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly logger: InstallLogger;
}

export async function resolveArtifact(
  request: ArtifactRequest,
): Promise<HostdArtifact | ArtifactFailure> {
  const { version, target, logger, pin } = request;
  const fileName = artifactFileName(version, target);
  const found = (path: string, sha256: string, source: HostdArtifact["source"]): HostdArtifact => {
    const bytes = statSync(path).size;
    logger.info("artifact ready", { fileName, source, bytes, sha256 });
    return { version, target, fileName, path, sha256, bytes, source };
  };

  if (pin === null || pin.assets.length === 0) {
    const tarball = (request.devTarballs ?? []).find((path) => basename(path) === fileName) ?? null;
    if (tarball === null) {
      return {
        kind: "artifact-unavailable",
        detail: `This build carries no hostd release assets; give it a local ${fileName} (dev builds only).`,
      };
    }
    let expected: string | null;
    try {
      expected = parseChecksum(readFileSync(`${tarball}.sha256`, "utf8"));
    } catch {
      return { kind: "artifact-unavailable", detail: `${tarball}.sha256 is missing.` };
    }
    const actual = await sha256File(tarball);
    if (actual === null) return { kind: "artifact-unavailable", detail: `${tarball} is missing.` };
    if (expected === null || actual !== expected) {
      return { kind: "artifact-checksum", detail: `${tarball} does not match its .sha256.` };
    }
    return found(tarball, actual, "dev");
  }

  if (pin.version !== version) {
    return {
      kind: "artifact-unavailable",
      detail: `This app pins hostd ${pin.version}, not ${version}.`,
    };
  }
  const asset = pin.assets.find((entry) => entry.target === target);
  if (asset === undefined) {
    return { kind: "artifact-unavailable", detail: `This app pins no ${target} hostd.` };
  }

  const cached = join(request.cacheDir, version, fileName);
  const inCache = await sha256File(cached);
  if (inCache === asset.sha256) return found(cached, inCache, "cache");
  if (inCache !== null)
    logger.warn("cached artifact does not match the pin; fetching again", { fileName });

  const url = `${request.releaseBaseUrl ?? RELEASE_BASE_URL}/${pin.releaseTag}/${fileName}`;
  try {
    const response = await (request.fetch ?? fetch)(url);
    if (response.status === 404) {
      return {
        kind: "artifact-unavailable",
        detail: `${fileName} is not published at ${pin.releaseTag}.`,
      };
    }
    if (!response.ok || response.body === null) {
      return { kind: "artifact-fetch-failed", detail: `${url} answered ${response.status}.` };
    }
    mkdirSync(dirname(cached), { recursive: true });
    const partial = `${cached}.part`;
    const hash = createHash("sha256");
    const body = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(partial));
    const actual = hash.digest("hex");
    if (actual !== asset.sha256) {
      rmSync(partial, { force: true });
      return {
        kind: "artifact-checksum",
        detail: `${fileName} downloaded as ${actual}, not the pinned ${asset.sha256}.`,
      };
    }
    renameSync(partial, cached);
    return found(cached, actual, "release");
  } catch (error) {
    return { kind: "artifact-fetch-failed", detail: (error as Error).message };
  }
}
