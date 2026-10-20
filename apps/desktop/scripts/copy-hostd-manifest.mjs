import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  releaseVersion,
  repositoryRoot,
  validateReleaseManifest,
} from "../../../scripts/hostd-release-manifest.mjs";

export function copyHostdManifest({
  root = repositoryRoot,
  manifestPath = process.env.VOLLI_HOSTD_MANIFEST,
} = {}) {
  const version = releaseVersion(root);
  const manifest =
    manifestPath === undefined
      ? {
          schemaVersion: 1,
          version,
          releaseTag: `v${version}`,
          assets: [],
          unavailableReason: "Local build: VOLLI_HOSTD_MANIFEST is not set.",
        }
      : validateReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")), version);
  const destination = join(root, "apps/desktop/dist-electron/hostd-release-manifest.json");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = copyHostdManifest();
    console.log(
      manifest.assets.length === 0
        ? manifest.unavailableReason
        : `Copied hostd release manifest for ${manifest.releaseTag}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
