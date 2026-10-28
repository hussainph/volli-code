/**
 * Which object keys a move may write (`projectImports.presignPut`): the
 * moved project's own (`v1/p/<projectId>/…`), the move's staging
 * (`v1/m/<moveId>/<part>`), and the importer's kept legacy archive
 * (`v1/u/<userId>/legacy/…`). Each key is parsed into its layout's parts and
 * derived again with `r2-keys.ts`; only a key equal to its own derivation
 * passes, so nothing outside those layouts (and nothing of another project,
 * move or person) can be signed.
 */

import {
  SESSION_OBJECT_MAX_BYTES,
  artifactSpillKey,
  eventArchiveKey,
  eventSpillKey,
  legacyArchiveKey,
  migrationKey,
  migrationPrefix,
  piLogSegmentKey,
  projectBlobKey,
  projectPrefix,
  transcriptPackKey,
  userLegacyArchiveKey,
  userPrefix,
} from "@volli/shared/cloud";

/** The largest object one S3 PUT may carry (5 GiB). */
const S3_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** The most bytes one PUT to `key` may carry: a Session's history objects are bounded tighter. */
export function moveObjectMaxBytes(key: string): number {
  return /^v1\/p\/[^/]+\/s\//.test(key) ? SESSION_OBJECT_MAX_BYTES : S3_PUT_MAX_BYTES;
}

export interface MoveObjectScope {
  moveId: string;
  projectId: string;
  userId: string;
  /** The object's SHA-256: a blob's key must be its own. */
  sha256: string;
}

const RANGE = /^(\d{12})-(\d{12})$/;

/** The key as derived from what `rest` (the part after a Session's prefix) parses into, or `null`. */
function sessionKey(projectId: string, sessionId: string, rest: string): string | null {
  const scope = { projectId, sessionId };
  const [family, ...parts] = rest.split("/");
  const name = parts.join("/");
  const range = (suffix: string) => {
    if (!name.endsWith(suffix)) return null;
    const match = RANGE.exec(name.slice(0, -suffix.length));
    return match === null
      ? null
      : { ...scope, firstSequence: Number(match[1]), lastSequence: Number(match[2]) };
  };
  switch (family) {
    case "tx": {
      const parsed = range(".pack.zst");
      return parsed === null ? null : transcriptPackKey(parsed);
    }
    case "ev": {
      const parsed = range(".ndjson.zst");
      return parsed === null ? null : eventArchiveKey(parsed);
    }
    case "a":
      return name.endsWith(".json.zst")
        ? artifactSpillKey({ ...scope, sha256: name.slice(0, -".json.zst".length) })
        : null;
    case "e":
      return /^\d{12}\.json\.zst$/.test(name)
        ? eventSpillKey({ ...scope, sequence: Number(name.slice(0, 12)) })
        : null;
    case "pi": {
      const match = /^([^/]+)\/([^/]+)\/(\d{15})\.jsonl\.zst$/.exec(name);
      return match === null
        ? null
        : piLogSegmentKey({
            ...scope,
            attachmentId: match[1]!,
            piFileId: match[2]!,
            offset: Number(match[3]),
          });
    }
    default:
      return null;
  }
}

/** The key as derived from what it parses into, or `null` when it is none of a move's layouts. */
function derive(key: string, scope: MoveObjectScope): string | null {
  const staging = migrationPrefix(scope.moveId);
  if (key.startsWith(staging)) return migrationKey(scope.moveId, key.slice(staging.length));

  const person = userPrefix(scope.userId);
  if (key.startsWith(person)) {
    const match = /^legacy\/(.+)\.ndjson\.zst$/.exec(key.slice(person.length));
    return match === null ? null : userLegacyArchiveKey(scope.userId, match[1]!);
  }

  const project = projectPrefix(scope.projectId);
  if (!key.startsWith(project)) return null;
  const rest = key.slice(project.length);
  // A blob is content-addressed: its key is its own SHA-256.
  if (rest.startsWith("b/")) return projectBlobKey(scope.projectId, scope.sha256);
  const legacy = /^legacy\/(.+)\.ndjson\.zst$/.exec(rest);
  if (legacy !== null) return legacyArchiveKey(scope.projectId, legacy[1]!);
  const session = /^s\/([^/]+)\/(.+)$/.exec(rest);
  return session === null ? null : sessionKey(scope.projectId, session[1]!, session[2]!);
}

/** Why a move may not write `key`, or `null` when it may. Never echoes the key. */
export function moveObjectKeyProblem(key: string, scope: MoveObjectScope): string | null {
  let derived: string | null;
  try {
    derived = derive(key, scope);
  } catch {
    // A part that is not of the form its slot requires (`InvalidKeyPartError`).
    derived = null;
  }
  return derived === key
    ? null
    : "The key is not one this move writes: the moved project's, the move's staging or your legacy archive.";
}
