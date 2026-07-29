/**
 * The bring-your-own-harness half of the registry: manifests on disk under
 * `~/.agents/harnesses/<slug>/harness.json`, turned into adapters that are
 * indistinguishable from the built-in ones — but only after somebody confirmed
 * what they will run.
 *
 * Two steps, deliberately separable. {@link scanHarnessManifests} touches the
 * filesystem and nothing else; {@link decideRegisteredHarnesses} touches the db
 * and nothing else. Neither can launch anything: only
 * {@link trustedHarnessAdapters} yields adapters, and it yields none for a
 * manifest that failed to parse, whatever verdict was recorded about it.
 *
 * Every manifest is re-read and re-hashed at boot. The stored verdict is about
 * bytes, so a file edited between launches decides itself — nothing has to
 * notice the edit.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { harnessTrustDecision, parseHarnessManifest } from "@volli/shared";
import type { HarnessAdapter, HarnessTrustDecision, ManifestError } from "@volli/shared";

import { getRegisteredHarness } from "./db/harness-registry-repo";

/** The filename inside each `~/.agents/harnesses/<slug>/` directory. */
const MANIFEST_FILENAME = "harness.json";

export interface ScannedHarnessManifest {
  /** The directory the manifest was found in — the name a valid manifest must agree with. */
  slug: string;
  manifestPath: string;
  /** SHA-256 of the bytes read, recorded even for a manifest that failed to parse. */
  manifestSha256: string;
  /** `null` when the manifest could not be read or did not validate. */
  adapter: HarnessAdapter | null;
  errors: readonly ManifestError[];
}

export interface DecidedHarnessManifest extends ScannedHarnessManifest {
  decision: HarnessTrustDecision;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function scanOne(harnessesDir: string, slug: string): Promise<ScannedHarnessManifest | null> {
  const manifestPath = join(harnessesDir, slug, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return null; // no manifest in this directory — not a harness, not an error
  }
  const manifestSha256 = sha256(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      slug,
      manifestPath,
      manifestSha256,
      adapter: null,
      errors: [{ path: "", message: "must be readable JSON" }],
    };
  }
  const result = parseHarnessManifest(parsed);
  if (!result.ok) {
    return { slug, manifestPath, manifestSha256, adapter: null, errors: result.errors };
  }
  // The directory name is what the app, the wrapper environment and the trust
  // row all key on, so a manifest naming a different slug is refused rather than
  // silently filed under one of the two names.
  if (result.adapter.id !== slug) {
    return {
      slug,
      manifestPath,
      manifestSha256,
      adapter: null,
      errors: [{ path: "slug", message: "must match the directory it lives in" }],
    };
  }
  return { slug, manifestPath, manifestSha256, adapter: result.adapter, errors: [] };
}

/**
 * Every manifest under `harnessesDir`, read and hashed. A missing directory
 * means nobody has registered a harness, which is the ordinary case and not a
 * failure.
 */
export async function scanHarnessManifests(
  harnessesDir: string,
): Promise<ScannedHarnessManifest[]> {
  let entries: string[];
  try {
    entries = (await readdir(harnessesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
  const scanned: ScannedHarnessManifest[] = [];
  for (const slug of entries) {
    const manifest = await scanOne(harnessesDir, slug);
    if (manifest !== null) scanned.push(manifest);
  }
  return scanned;
}

/** Pairs each scanned manifest with the verdict recorded about those exact bytes. */
export function decideRegisteredHarnesses(
  db: Database.Database,
  scanned: readonly ScannedHarnessManifest[],
): DecidedHarnessManifest[] {
  return scanned.map((manifest) => {
    const record = getRegisteredHarness(db, manifest.slug);
    return {
      ...manifest,
      decision: harnessTrustDecision({
        currentHash: manifest.manifestSha256,
        recordedHash: record?.manifestSha256 ?? null,
        recordedVerdict: record?.decision ?? null,
      }),
    };
  });
}

/**
 * The adapters a launch may actually use. A manifest that did not parse yields
 * nothing even when it was trusted — the verdict was about a file, and this is
 * about what Volli can execute.
 */
export function trustedHarnessAdapters(
  decided: readonly DecidedHarnessManifest[],
): HarnessAdapter[] {
  return decided
    .filter((manifest) => manifest.decision === "trusted" && manifest.adapter !== null)
    .map((manifest) => manifest.adapter)
    .filter((adapter) => adapter !== null);
}
