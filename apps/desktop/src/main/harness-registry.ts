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
import {
  harnessEventStatus,
  harnessTrustDecision,
  isFirstClassHarnessId,
  parseHarnessManifest,
} from "@volli/shared";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessEventStatus,
  HarnessId,
  HarnessTrustDecision,
  ManifestError,
} from "@volli/shared";

import { getRegisteredHarness, markHarnessEventVerified } from "./db/harness-registry-repo";

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

/**
 * Records that a harness really delivered `event`, and answers what Volli knows
 * about that capability now that it has.
 *
 * The ledger is written BEFORE it is read, because delivery is the evidence.
 * Asking first and recording after would swallow the first `input.needed` a
 * harness ever sends — the one a human is already waiting on — and a harness
 * that blocks once per session would never earn a notification at all.
 *
 * A first-class harness has no row and needs none: its bindings are Volli's own
 * code, checked against the installed binary before they were written down, so
 * there is no claim here for a ledger to keep honest. Everything else is a
 * registered manifest, and one Volli has no record of — deleted, never
 * confirmed — gets its event recorded and nothing else. Automation follows
 * evidence, and a harness the app no longer knows has produced none.
 */
export function recordHarnessDelivery(
  db: Database.Database,
  harnessId: HarnessId,
  event: HarnessEvent,
  now: number,
): HarnessEventStatus {
  if (isFirstClassHarnessId(harnessId)) return "verified";
  markHarnessEventVerified(db, harnessId, event, now);
  const record = getRegisteredHarness(db, harnessId);
  if (record === undefined) return "absent";
  return harnessEventStatus(event, {
    declared: new Set(record.declaredEvents),
    verified: new Set(record.verifiedEvents),
  });
}
