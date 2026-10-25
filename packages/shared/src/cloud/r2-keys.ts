/**
 * The object-storage key layout (v1).
 *
 * Writers derive a key with these functions; the backend's index rows store
 * the key VERBATIM; readers use the stored key and never re-derive it, so a
 * later layout can never strand an object written under this one.
 *
 * Keys are rooted in owners that never move: a project's objects stay valid
 * when the project changes Workspace, and a Session never changes project.
 * Purging an owner is one prefix delete ({@link sessionPrefix},
 * {@link projectPrefix}, {@link workspacePrefix}, {@link userPrefix}).
 *
 * Only UUIDs, content hashes, zero-padded integers, opaque derived ids and
 * fixed literals appear. No names, paths or backend row ids. Zero padding
 * keeps lexical order equal to numeric order, so a prefix list is a range read.
 */

import { isUuid } from "./ids";

export const R2_LAYOUT_VERSION = "v1";

/** Thrown when a key part is not of the form its slot requires. */
export class InvalidKeyPartError extends Error {
  readonly code = "invalid_key_part";
  constructor(slot: string, value: unknown) {
    super(`Invalid ${slot} for an object key: ${JSON.stringify(value)}`);
    this.name = "InvalidKeyPartError";
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
// Opaque derived ids (attachment ids, Pi file ids, export parts): one path
// segment, no traversal, no separators, no whitespace.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LEGACY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function uuid(slot: string, value: string): string {
  if (!isUuid(value)) throw new InvalidKeyPartError(slot, value);
  return value;
}

function sha(slot: string, value: string): string {
  if (!SHA256_HEX.test(value)) throw new InvalidKeyPartError(slot, value);
  return value;
}

function segment(slot: string, value: string): string {
  if (!SEGMENT.test(value) || value.includes("..")) throw new InvalidKeyPartError(slot, value);
  return value;
}

function padded(slot: string, value: number, width: number): string {
  const text = Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  if (text === "" || text.length > width) throw new InvalidKeyPartError(slot, value);
  return text.padStart(width, "0");
}

function range(first: number, last: number): string {
  if (Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > last) {
    throw new InvalidKeyPartError("sequence range", `${first}-${last}`);
  }
  return `${padded("firstSequence", first, 12)}-${padded("lastSequence", last, 12)}`;
}

function revision(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidKeyPartError("revision", value);
  return String(value);
}

export interface SessionKeyScope {
  projectId: string;
  sessionId: string;
}

// ── prefixes (purge) ─────────────────────────────────────────────────────────

export function projectPrefix(projectId: string): string {
  return `${R2_LAYOUT_VERSION}/p/${uuid("projectId", projectId)}/`;
}

export function sessionPrefix({ projectId, sessionId }: SessionKeyScope): string {
  return `${projectPrefix(projectId)}s/${uuid("sessionId", sessionId)}/`;
}

export function workspacePrefix(workspaceId: string): string {
  return `${R2_LAYOUT_VERSION}/w/${uuid("workspaceId", workspaceId)}/`;
}

export function userPrefix(userId: string): string {
  return `${R2_LAYOUT_VERSION}/u/${uuid("userId", userId)}/`;
}

// ── Session history ──────────────────────────────────────────────────────────

/** A transcript pack: the artifacts referenced by events `first..last` (`volli.transcript-pack/1`). */
export function transcriptPackKey(
  scope: SessionKeyScope & { firstSequence: number; lastSequence: number },
): string {
  return `${sessionPrefix(scope)}tx/${range(scope.firstSequence, scope.lastSequence)}.pack.zst`;
}

/** An artifact body too large to stage inline, stored on its own. */
export function artifactSpillKey(scope: SessionKeyScope & { sha256: string }): string {
  return `${sessionPrefix(scope)}a/${sha("sha256", scope.sha256)}.json.zst`;
}

/** Archived Session events `first..last` (`volli.session-events/1`). */
export function eventArchiveKey(
  scope: SessionKeyScope & { firstSequence: number; lastSequence: number },
): string {
  return `${sessionPrefix(scope)}ev/${range(scope.firstSequence, scope.lastSequence)}.ndjson.zst`;
}

/** One oversize event payload, spilled out of its event. */
export function eventSpillKey(scope: SessionKeyScope & { sequence: number }): string {
  return `${sessionPrefix(scope)}e/${padded("sequence", scope.sequence, 12)}.json.zst`;
}

/** A byte range of one Pi session file, starting at `offset`. */
export function piLogSegmentKey(
  scope: SessionKeyScope & { attachmentId: string; piFileId: string; offset: number },
): string {
  return (
    `${sessionPrefix(scope)}pi/${segment("attachmentId", scope.attachmentId)}/` +
    `${segment("piFileId", scope.piFileId)}/${padded("offset", scope.offset, 15)}.jsonl.zst`
  );
}

// ── project objects ──────────────────────────────────────────────────────────

/** A project blob (attachments, images), content-addressed within the project. */
export function projectBlobKey(projectId: string, sha256: string): string {
  return `${projectPrefix(projectId)}b/${sha("sha256", sha256)}`;
}

/** An environment run's full log. */
export function environmentRunLogKey(projectId: string, runId: string): string {
  return `${projectPrefix(projectId)}env/${uuid("runId", runId)}.log.zst`;
}

/** One revision of a project-level config bundle (skills, plugins). */
export function projectConfigBundleKey(
  projectId: string,
  entryId: string,
  entryRevision: number,
): string {
  return `${projectPrefix(projectId)}cfg/${uuid("entryId", entryId)}/${revision(entryRevision)}.tar.zst`;
}

/** A migrated local-only ledger, kept as one archive (`name` is a fixed lowercase literal). */
export function legacyArchiveKey(projectId: string, name: string): string {
  if (!LEGACY_NAME.test(name)) throw new InvalidKeyPartError("legacy name", name);
  return `${projectPrefix(projectId)}legacy/${name}.ndjson.zst`;
}

// ── Workspace and person objects ─────────────────────────────────────────────

export function workspaceBlobKey(workspaceId: string, sha256: string): string {
  return `${workspacePrefix(workspaceId)}b/${sha("sha256", sha256)}`;
}

export function workspaceConfigBundleKey(
  workspaceId: string,
  entryId: string,
  entryRevision: number,
): string {
  return `${workspacePrefix(workspaceId)}cfg/${uuid("entryId", entryId)}/${revision(entryRevision)}.tar.zst`;
}

export function userBlobKey(userId: string, sha256: string): string {
  return `${userPrefix(userId)}b/${sha("sha256", sha256)}`;
}

export function userConfigBundleKey(
  userId: string,
  entryId: string,
  entryRevision: number,
): string {
  return `${userPrefix(userId)}cfg/${uuid("entryId", entryId)}/${revision(entryRevision)}.tar.zst`;
}

// ── transient bundles (lifecycle rules expire these prefixes) ────────────────

/** One part of an export bundle. `v1/x/` expires after 7 days. */
export function exportKey(exportId: string, part: string): string {
  return `${R2_LAYOUT_VERSION}/x/${uuid("exportId", exportId)}/${segment("part", part)}`;
}

/** One part of a migration's staging. `v1/m/` expires after 30 days. */
export function migrationKey(migrationId: string, part: string): string {
  return `${R2_LAYOUT_VERSION}/m/${uuid("migrationId", migrationId)}/${segment("part", part)}`;
}
