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
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import {
  errorMessage,
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

/**
 * How many directories one scan will look inside.
 *
 * The walk runs on the way to first paint and every `JSON.parse` in it blocks
 * main outright, so the cost of the directory has to be bounded by something
 * other than the user's good behaviour — a checkout, a sync client or a runaway
 * script can put thousands of directories here. Sixty-four is far past any real
 * install and still cheap; the overflow is named in the log rather than
 * disappearing, and marks the scan as a non-census so nothing downstream reads
 * the harnesses it did not reach as harnesses that are gone.
 */
export const MAX_SCANNED_HARNESS_DIRS = 64;

/**
 * How large a file may be and still be treated as a manifest.
 *
 * A verdict is about bytes, so every manifest is read whole and hashed whole —
 * which makes an unbounded file an unbounded read, and a manifest that is a
 * symlink to something enormous a boot that never finishes. A real manifest is
 * a few hundred bytes.
 */
export const MAX_MANIFEST_BYTES = 256 * 1024;

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

/**
 * Why a scan is not a census of the directory. Each of these leaves at least one
 * directory unmeasured, which is a different answer from measuring it and
 * finding nothing — and the difference is destructive: a caller that reconciles
 * wrappers against "every harness there is" would delete the wrappers of the
 * harnesses this scan never reached.
 */
export type HarnessScanGap =
  /** The directory itself would not list. Nothing was measured at all. */
  | "directory-unreadable"
  /** A directory was there but its manifest would not read — a permissions blip, an EMFILE. */
  | "manifest-unreadable"
  /** More directories than {@link MAX_SCANNED_HARNESS_DIRS}; the tail was never opened. */
  | "too-many-manifests";

/** One walk of the manifest directory: what it read, and whether that was all there was. */
export interface HarnessManifestScan {
  manifests: ScannedHarnessManifest[];
  /** `null` — and only `null` — means this is the whole directory. */
  gap: HarnessScanGap | null;
}

/**
 * What one directory yielded. `"nothing"` is a measurement (no manifest here, or
 * a file too large to be one); `"failed"` is the absence of one.
 */
type ScannedDirectory =
  | { read: "manifest"; manifest: ScannedHarnessManifest }
  | { read: "nothing" }
  | { read: "failed" };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function scanOne(harnessesDir: string, slug: string): Promise<ScannedDirectory> {
  const manifestPath = join(harnessesDir, slug, MANIFEST_FILENAME);
  // Sized before it is read, because the read is the unbounded part. A manifest
  // is allowed to be a symlink — people keep these in dotfile repos — so this
  // follows it and asks about the file at the end of it, which is the file whose
  // bytes would be hashed.
  try {
    const entry = await stat(manifestPath);
    if (!entry.isFile()) return { read: "nothing" };
    if (entry.size > MAX_MANIFEST_BYTES) {
      console.warn(
        `[harness] skipped ${manifestPath}: ${entry.size} bytes is larger than a manifest can be (${MAX_MANIFEST_BYTES})`,
      );
      return { read: "nothing" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { read: "nothing" };
    console.warn(`[harness] could not stat ${manifestPath}: ${errorMessage(error)}`);
    return { read: "failed" };
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    // ENOENT here is a file deleted between the stat and the read, which is
    // still just a directory with no manifest in it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { read: "nothing" };
    console.warn(`[harness] could not read ${manifestPath}: ${errorMessage(error)}`);
    return { read: "failed" };
  }
  return { read: "manifest", manifest: parseOne(manifestPath, slug, raw) };
}

function parseOne(manifestPath: string, slug: string, raw: string): ScannedHarnessManifest {
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
 * Every manifest under `harnessesDir`, read and hashed — and, separately, whether
 * that is every manifest there is.
 *
 * A missing directory means nobody has registered a harness: the ordinary case,
 * a complete answer, `gap: null`. A directory that would not open means nothing
 * was learned, and it is reported as such rather than as an empty host. The two
 * used to share the empty array, which made one unlucky `readdir` — a
 * permissions blip, a network mount mid-reconnect, an EMFILE under load — say
 * "this user has no registered harnesses", to a caller that deletes the wrappers
 * of harnesses that are gone.
 */
export async function scanHarnessManifests(harnessesDir: string): Promise<HarnessManifestScan> {
  let entries: string[];
  try {
    entries = (await readdir(harnessesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { manifests: [], gap: null };
    console.warn(`[harness] could not list ${harnessesDir}: ${errorMessage(error)}`);
    return { manifests: [], gap: "directory-unreadable" };
  }
  let gap: HarnessScanGap | null = null;
  const examined = entries.slice(0, MAX_SCANNED_HARNESS_DIRS);
  const skipped = entries.slice(MAX_SCANNED_HARNESS_DIRS);
  if (skipped.length > 0) {
    gap = "too-many-manifests";
    console.warn(
      `[harness] ${harnessesDir} holds ${entries.length} directories; read the first ${MAX_SCANNED_HARNESS_DIRS} and skipped ${skipped.join(", ")}`,
    );
  }
  const manifests: ScannedHarnessManifest[] = [];
  for (const slug of examined) {
    const outcome = await scanOne(harnessesDir, slug);
    if (outcome.read === "manifest") manifests.push(outcome.manifest);
    // A single unreadable manifest is one harness this scan cannot speak for,
    // which is enough to disqualify the whole thing as a census.
    else if (outcome.read === "failed") gap ??= "manifest-unreadable";
  }
  return { manifests, gap };
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
