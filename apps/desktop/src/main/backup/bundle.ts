/**
 * The backup bundle: one archive, one manifest, one data document, and every
 * artifact the data document refers to.
 *
 * A SEPARATE, VERSIONED FORMAT, deliberately not `volli-export` JSON. The two
 * files answer different questions — one is read by a person, the other is
 * written back into a profile — and a reader that accepted both would be a
 * reader that promises a restore from a document with no attachments and no
 * transcripts in it. {@link readBackupBundle} names that case explicitly
 * rather than failing on a missing field, because "this is the export, not the
 * backup" is the sentence a person needs.
 *
 * The manifest is what makes the bundle checkable. It carries the size and
 * SHA-256 of the data document and of every artifact, so a reader can tell a
 * bundle that is missing a file from one whose bytes changed underneath it,
 * and can say which. The manifest does not hash itself: a self-hash is worth
 * exactly as much as the copy of it sitting beside it, and every entry it
 * covers is verified against the bytes actually present.
 *
 * Streaming, progress, cancellation and atomic writes are VC-317's, and this
 * shape is chosen not to stand in their way: the reader takes bytes, the
 * writer returns bytes, and neither owns a file handle or a dialog.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";

import { blobFilePath } from "../blob-store";
import {
  createFileTranscriptArtifactStore,
  transcriptReferenceForId,
} from "../session-runtime/transcript-artifacts";
import { ArchiveError, isSafeArchivePath, packArchive, unpackArchive } from "./archive";
import type { ArchiveEntry } from "./archive";
import {
  buildBackupDataDocument,
  collectBlobHashes,
  collectTranscriptReferences,
  serializeBackupDataDocument,
  validateBackupDataDocument,
  validateRecordLinks,
} from "./data-document";
import type { BackupDataDocument, BackupProblem } from "./data-document";

/** The bundle's format marker. Distinct from `volli-export` on purpose. */
export const BACKUP_BUNDLE_FORMAT = "volli-backup";

/** The bundle version this build writes. */
export const BACKUP_BUNDLE_VERSION = 1;

/**
 * Every bundle version this build can READ.
 *
 * Older documented versions belong here as they accumulate; a version not in
 * this list is refused with a report rather than guessed at. A NEWER version
 * is refused for the same reason and said differently, because "this backup
 * was made by a later version of Volli" is an instruction to upgrade, not a
 * corruption report.
 */
export const SUPPORTED_BUNDLE_VERSIONS: readonly number[] = [1];

export const MANIFEST_PATH = "manifest.json";
export const DATA_PATH = "data.json";
export const BLOB_PREFIX = "artifacts/blobs/";
export const TRANSCRIPT_PREFIX = "artifacts/transcripts/";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export type BackupEntryKind = "data" | "blob" | "transcript";

export interface BackupManifestEntry {
  path: string;
  kind: BackupEntryKind;
  sizeBytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_BUNDLE_FORMAT;
  bundleVersion: number;
  /** The app that wrote the bundle. */
  appVersion: string;
  /** The source database's `PRAGMA user_version`. */
  schemaVersion: number;
  createdAt: string;
  entries: BackupManifestEntry[];
}

export class BackupBundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupBundleError";
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `sha256:<hex>` → the transcript artifact's archive path. */
export function transcriptArtifactPath(referenceId: string): string {
  return `${TRANSCRIPT_PREFIX}${referenceId.slice("sha256:".length)}.json`;
}

/** A blob hash → its archive path. */
export function blobArtifactPath(hash: string): string {
  return `${BLOB_PREFIX}${hash}`;
}

export interface CreateBackupBundleOptions {
  db: Database.Database;
  /** The blob store root of the profile being backed up. */
  blobsRoot: string;
  /** The transcript store root of the profile being backed up. */
  transcriptsRoot: string;
  appVersion: string;
  now: number;
}

export interface CreatedBackupBundle {
  bytes: Buffer;
  manifest: BackupManifest;
  document: BackupDataDocument;
}

/**
 * Builds a complete bundle from a live profile.
 *
 * Incomplete is not an option here: a referenced artifact that is missing or
 * whose bytes no longer match its own hash throws, because a bundle that
 * silently omits an attachment is precisely the failure this ticket exists to
 * end. The caller surfaces it; nobody gets a file that looks like a backup and
 * is not one.
 */
export function createBackupBundle(options: CreateBackupBundleOptions): CreatedBackupBundle {
  const document = buildBackupDataDocument(options.db, {
    appVersion: options.appVersion,
    now: options.now,
  });
  const dataBytes = serializeBackupDataDocument(document);
  const entries: ArchiveEntry[] = [];
  const manifestEntries: BackupManifestEntry[] = [
    { path: DATA_PATH, kind: "data", sizeBytes: dataBytes.length, sha256: sha256(dataBytes) },
  ];
  entries.push({ path: DATA_PATH, bytes: dataBytes });

  for (const hash of collectBlobHashes(document)) {
    if (!SHA256_HEX.test(hash)) {
      throw new BackupBundleError(`Blob hash ${JSON.stringify(hash)} is not a SHA-256 digest.`);
    }
    const path = blobFilePath(options.blobsRoot, hash);
    if (!existsSync(path)) {
      throw new BackupBundleError(`Attachment bytes for ${hash} are missing from the blob store.`);
    }
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    if (digest !== hash) {
      throw new BackupBundleError(`Attachment bytes for ${hash} no longer match their own hash.`);
    }
    entries.push({ path: blobArtifactPath(hash), bytes });
    manifestEntries.push({
      path: blobArtifactPath(hash),
      kind: "blob",
      sizeBytes: bytes.length,
      sha256: digest,
    });
  }

  const transcripts = createFileTranscriptArtifactStore(options.transcriptsRoot);
  for (const reference of collectTranscriptReferences(document)) {
    let bytes: Buffer;
    try {
      bytes = transcripts.readCanonicalBytesSync(transcriptReferenceForId(reference));
    } catch (error) {
      if (isMissing(error)) {
        throw new BackupBundleError(
          `Transcript ${reference} is missing from the transcript store.`,
        );
      }
      throw new BackupBundleError(`Transcript ${reference} no longer matches its own digest.`, {
        cause: error,
      });
    }
    const digest = sha256(bytes);
    entries.push({ path: transcriptArtifactPath(reference), bytes });
    manifestEntries.push({
      path: transcriptArtifactPath(reference),
      kind: "transcript",
      sizeBytes: bytes.length,
      sha256: digest,
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_BUNDLE_FORMAT,
    bundleVersion: BACKUP_BUNDLE_VERSION,
    appVersion: options.appVersion,
    schemaVersion: document.schemaVersion,
    createdAt: document.createdAt,
    entries: manifestEntries,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // The manifest goes first so a reader (and `tar -t`) meets the inventory
  // before the bytes it describes.
  return {
    bytes: packArchive([{ path: MANIFEST_PATH, bytes: manifestBytes }, ...entries]),
    manifest,
    document,
  };
}

export interface ReadBackupBundle {
  manifest: BackupManifest;
  document: BackupDataDocument;
  /** Verified artifact bytes, keyed by archive path. */
  artifacts: Map<string, Buffer>;
}

export type ReadBackupBundleResult =
  | { ok: true; bundle: ReadBackupBundle }
  | { ok: false; problems: BackupProblem[] };

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(bytes: Buffer): { manifest?: BackupManifest; problems: BackupProblem[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { problems: [{ kind: "manifest", message: "Bundle manifest is not valid JSON." }] };
  }
  if (!isRecord(parsed)) {
    return { problems: [{ kind: "manifest", message: "Bundle manifest is not an object." }] };
  }
  if (parsed.format === "volli-export") {
    return {
      problems: [
        {
          kind: "manifest",
          message:
            "This is a volli-export JSON file, not a backup bundle. The JSON export is a limited data export and cannot be restored.",
        },
      ],
    };
  }
  if (parsed.format !== BACKUP_BUNDLE_FORMAT) {
    return {
      problems: [
        { kind: "manifest", message: `Bundle manifest format is not ${BACKUP_BUNDLE_FORMAT}.` },
      ],
    };
  }
  const version = parsed.bundleVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { problems: [{ kind: "manifest", message: "Bundle manifest has no bundleVersion." }] };
  }
  if (!SUPPORTED_BUNDLE_VERSIONS.includes(version)) {
    return {
      problems: [
        {
          kind: "unsupported-version",
          message:
            version > BACKUP_BUNDLE_VERSION
              ? `This backup was written by a newer version of Volli (bundle version ${version}); this build reads ${SUPPORTED_BUNDLE_VERSIONS.join(", ")}. Update Volli and try again.`
              : `Bundle version ${version} is not supported; this build reads ${SUPPORTED_BUNDLE_VERSIONS.join(", ")}.`,
        },
      ],
    };
  }
  const problems: BackupProblem[] = [];
  if (typeof parsed.appVersion !== "string") {
    problems.push({ kind: "manifest", message: "Bundle manifest has no appVersion." });
  }
  if (typeof parsed.schemaVersion !== "number" || !Number.isInteger(parsed.schemaVersion)) {
    problems.push({ kind: "manifest", message: "Bundle manifest has no schemaVersion." });
  }
  if (typeof parsed.createdAt !== "string") {
    problems.push({ kind: "manifest", message: "Bundle manifest has no createdAt." });
  }
  if (!Array.isArray(parsed.entries)) {
    problems.push({ kind: "manifest", message: "Bundle manifest has no entry inventory." });
    return { problems };
  }
  for (const [index, entry] of parsed.entries.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sizeBytes !== "number" ||
      !Number.isInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256_HEX.test(entry.sha256) ||
      (entry.kind !== "data" && entry.kind !== "blob" && entry.kind !== "transcript")
    ) {
      problems.push({ kind: "manifest", message: `Bundle manifest entry ${index} is malformed.` });
      continue;
    }
    if (!isSafeArchivePath(entry.path)) {
      problems.push({
        kind: "manifest",
        message: `Bundle manifest entry ${JSON.stringify(entry.path)} has an unsafe path.`,
      });
    }
  }
  if (problems.length > 0) return { problems };
  return { manifest: parsed as unknown as BackupManifest, problems: [] };
}

/**
 * The path shape each entry kind is allowed to take.
 *
 * An artifact is content-addressed on BOTH stores, so its name and its hash
 * have to be the same fact stated twice. Checking that here closes the gap
 * where a manifest names `artifacts/blobs/<A>` for bytes that hash to `<B>`:
 * the bytes would verify, and the file would then be written into the store
 * under `<B>`, leaving the record that asked for `<A>` pointing at nothing.
 */
function expectedPathProblem(entry: BackupManifestEntry): string | null {
  switch (entry.kind) {
    case "data":
      return entry.path === DATA_PATH ? null : `data entry must be ${DATA_PATH}`;
    case "blob": {
      if (!entry.path.startsWith(BLOB_PREFIX)) return `blob entry must be ${BLOB_PREFIX}<sha256>`;
      const named = entry.path.slice(BLOB_PREFIX.length);
      if (!SHA256_HEX.test(named)) return `blob entry must be ${BLOB_PREFIX}<sha256>`;
      return named === entry.sha256 ? null : "blob entry is named for a different hash";
    }
    case "transcript": {
      if (!entry.path.startsWith(TRANSCRIPT_PREFIX) || !entry.path.endsWith(".json")) {
        return `transcript entry must be ${TRANSCRIPT_PREFIX}<sha256>.json`;
      }
      const named = entry.path.slice(TRANSCRIPT_PREFIX.length, entry.path.length - ".json".length);
      if (!SHA256_HEX.test(named))
        return `transcript entry must be ${TRANSCRIPT_PREFIX}<sha256>.json`;
      return named === entry.sha256 ? null : "transcript entry is named for a different digest";
    }
  }
}

/**
 * Opens a bundle and checks everything that can be checked from its bytes.
 *
 * Nothing here touches a profile: this is the pass that has to be able to say
 * "no" before a restore exists. The order is deliberate — container, then
 * manifest, then inventory, then hashes, then the data document, then the
 * links between records and artifacts — because each stage's report is only
 * meaningful if the one before it held.
 */
export function readBackupBundle(bytes: Buffer): ReadBackupBundleResult {
  let entries: ArchiveEntry[];
  try {
    entries = unpackArchive(bytes);
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          kind: "archive",
          message:
            error instanceof ArchiveError ? error.message : "Bundle archive could not be read.",
        },
      ],
    };
  }

  const files = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const manifestBytes = files.get(MANIFEST_PATH);
  if (manifestBytes === undefined) {
    return {
      ok: false,
      problems: [{ kind: "manifest", message: `Bundle has no ${MANIFEST_PATH}.` }],
    };
  }
  const parsed = parseManifest(manifestBytes);
  if (parsed.manifest === undefined) return { ok: false, problems: parsed.problems };
  const manifest = parsed.manifest;

  const problems: BackupProblem[] = [];
  const declared = new Set<string>();
  for (const entry of manifest.entries) {
    if (declared.has(entry.path)) {
      problems.push({
        kind: "manifest",
        message: `Bundle manifest lists ${entry.path} twice.`,
      });
      continue;
    }
    declared.add(entry.path);
    const shape = expectedPathProblem(entry);
    if (shape !== null) {
      problems.push({
        kind: "manifest",
        message: `Bundle manifest entry ${entry.path} is in the wrong place: ${shape}.`,
      });
      continue;
    }
    const bytesForEntry = files.get(entry.path);
    if (bytesForEntry === undefined) {
      problems.push({
        kind: "artifact-missing",
        message: `Bundle is missing ${entry.path}, which its manifest lists.`,
      });
      continue;
    }
    if (bytesForEntry.length !== entry.sizeBytes) {
      problems.push({
        kind: "artifact-corrupt",
        message: `${entry.path} is ${bytesForEntry.length} bytes; the manifest says ${entry.sizeBytes}.`,
      });
      continue;
    }
    const digest = sha256(bytesForEntry);
    if (digest !== entry.sha256) {
      problems.push({
        kind: "artifact-corrupt",
        message: `${entry.path} does not match the SHA-256 in the manifest.`,
      });
    }
  }
  for (const path of files.keys()) {
    if (path === MANIFEST_PATH) continue;
    if (!declared.has(path)) {
      problems.push({
        kind: "manifest",
        message: `Bundle holds ${path}, which its manifest does not list.`,
      });
    }
  }
  if (!declared.has(DATA_PATH)) {
    problems.push({ kind: "manifest", message: `Bundle manifest does not list ${DATA_PATH}.` });
  }
  if (problems.length > 0) return { ok: false, problems };

  let documentValue: unknown;
  try {
    documentValue = JSON.parse((files.get(DATA_PATH) as Buffer).toString("utf8"));
  } catch {
    return { ok: false, problems: [{ kind: "shape", message: "Bundle data is not valid JSON." }] };
  }
  const validated = validateBackupDataDocument(documentValue);
  if (!validated.ok) return { ok: false, problems: validated.problems };
  const document = validated.document;

  if (document.schemaVersion !== manifest.schemaVersion) {
    problems.push({
      kind: "manifest",
      message: `Bundle manifest says schema ${manifest.schemaVersion} but its data says ${document.schemaVersion}.`,
    });
  }
  problems.push(...validateRecordLinks(document));
  problems.push(...checkArtifactCoverage(document, manifest));
  if (problems.length > 0) return { ok: false, problems };

  const artifacts = new Map<string, Buffer>();
  for (const entry of manifest.entries) {
    if (entry.kind === "data") continue;
    artifacts.set(entry.path, files.get(entry.path) as Buffer);
  }
  return { ok: true, bundle: { manifest, document, artifacts } };
}

/**
 * Every referenced artifact is present exactly once, and no artifact is
 * present that nothing refers to.
 *
 * Both halves matter. A missing one is data loss on restore; a stray one is a
 * bundle carrying bytes no record accounts for, which is how something a
 * decision excluded gets in.
 */
function checkArtifactCoverage(
  document: BackupDataDocument,
  manifest: BackupManifest,
): BackupProblem[] {
  const problems: BackupProblem[] = [];
  const declaredByKind = (kind: BackupEntryKind): Set<string> =>
    new Set(manifest.entries.filter((entry) => entry.kind === kind).map((entry) => entry.path));

  const blobPaths = declaredByKind("blob");
  const expectedBlobs = new Set(collectBlobHashes(document).map(blobArtifactPath));
  for (const path of expectedBlobs) {
    if (!blobPaths.has(path)) {
      problems.push({
        kind: "artifact-missing",
        message: `Attachment ${path.slice(BLOB_PREFIX.length)} is referenced by a blob record but is not in the bundle.`,
      });
    }
  }
  for (const path of blobPaths) {
    if (!expectedBlobs.has(path)) {
      problems.push({
        kind: "manifest",
        message: `Bundle carries attachment ${path}, which no blob record references.`,
      });
    }
  }

  const transcriptPaths = declaredByKind("transcript");
  const expectedTranscripts = new Set(
    collectTranscriptReferences(document).map(transcriptArtifactPath),
  );
  for (const path of expectedTranscripts) {
    if (!transcriptPaths.has(path)) {
      problems.push({
        kind: "artifact-missing",
        message: `Transcript ${path.slice(TRANSCRIPT_PREFIX.length)} is referenced by the session ledger but is not in the bundle.`,
      });
    }
  }
  for (const path of transcriptPaths) {
    if (!expectedTranscripts.has(path)) {
      problems.push({
        kind: "manifest",
        message: `Bundle carries transcript ${path}, which no session record references.`,
      });
    }
  }

  // A blob_link that names a hash with no `blobs` row would pass the foreign
  // key check only if the row were there; the link validator covers that. What
  // it cannot see is a link pointing at a blob whose bytes never arrived,
  // which the two loops above turn into a named artifact problem.
  return problems;
}

/** `YYYY-MM-DD` in the caller's local time zone. */
function isoDateStamp(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The save dialog's default bundle filename, e.g. `volli-backup-2026-07-15.tar.gz`. */
export function defaultBackupFilename(now: Date): string {
  return `volli-backup-${isoDateStamp(now)}.tar.gz`;
}
