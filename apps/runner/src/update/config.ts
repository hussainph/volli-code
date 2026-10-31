/**
 * How this install updates: `<installRoot>/update.json`, written by the
 * installer (`src/install`) only when it differs from the default, and read
 * by both the daemon and the applier. It sits in the install root, which is
 * root's in system mode, so the applier can trust it where it cannot trust the
 * daemon's request.
 *
 * ```json
 * { "releaseOrigin": "https://github.com/hussainph/volli-code/releases/download/",
 *   "provenance": "required" }
 * ```
 *
 * - `releaseOrigin`: the prefix every release URL must sit under. A release's
 *   manifest is `<releaseOrigin>v<version>/volli-runner-manifest.json`, as
 *   GitHub serves it. install.sh's `--release-base` names one release
 *   (`…/v<version>`); its parent is the origin.
 * - `provenance`: `required` (the default) verifies the Sigstore bundle;
 *   `sha-only` checks only the manifest's SHA-256, for test release servers
 *   that cannot sign. Only the install root's owner can choose it.
 */
import { join } from "node:path";

import { readSmallFile } from "./files";
import type { UpdateLayout } from "./layout";
import { DEFAULT_RELEASE_ORIGIN, MANIFEST_ASSET, parseReleaseOrigin } from "./manifest";

export interface UpdateConfig {
  readonly releaseOrigin: string;
  readonly provenance: "required" | "sha-only";
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  releaseOrigin: DEFAULT_RELEASE_ORIGIN,
  provenance: "required",
};

export function updateConfigPath(layout: UpdateLayout): string {
  return join(layout.installRoot, "update.json");
}

/** The install's update config; the default when there is none. Throws on a damaged one. */
export function readUpdateConfig(layout: UpdateLayout): UpdateConfig {
  const path = updateConfigPath(layout);
  const text = readSmallFile(path, 4096);
  if (text === null) return DEFAULT_UPDATE_CONFIG;
  const row = JSON.parse(text) as Record<string, unknown>;
  const keys = row === null || typeof row !== "object" ? [] : Object.keys(row);
  if (
    keys.some((key) => key !== "releaseOrigin" && key !== "provenance") ||
    !(row.releaseOrigin === undefined || typeof row.releaseOrigin === "string") ||
    !(
      row.provenance === undefined ||
      row.provenance === "required" ||
      row.provenance === "sha-only"
    )
  ) {
    throw new Error(`${path} is not an update config this build reads.`);
  }
  return {
    releaseOrigin:
      row.releaseOrigin === undefined
        ? DEFAULT_RELEASE_ORIGIN
        : parseReleaseOrigin(row.releaseOrigin as string),
    provenance: (row.provenance as UpdateConfig["provenance"] | undefined) ?? "required",
  };
}

/** Where `version`'s manifest is published under `origin`. */
export function manifestUrlFor(origin: string, version: string): string {
  return `${origin}v${version}/${MANIFEST_ASSET}`;
}
