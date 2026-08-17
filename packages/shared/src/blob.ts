/**
 * Blobs: the bytes behind every user-supplied file, wherever it was attached
 * (VC-50, `docs/plans/attachments.md`). A Blob is content-addressed — its
 * sha256 IS its identity — and stored once under Electron `userData`, so the
 * same screenshot pasted into a Ticket and into a chat is one Blob with two
 * links rather than two copies. Deduplication is not an optimization here:
 * re-pasting the same screenshot is the single most common thing a user does
 * with this feature.
 *
 * `blob` is deliberately not called `attachment` in code. That noun is already
 * spoken for by the runtime binding (`SessionAttachment`, `attachment.opened`,
 * the durable `attachmentId` field), and those durable strings are frozen.
 * "Attachment" remains the user-facing word in UI copy, where nothing else
 * competes for it.
 *
 * Pure and shared: the renderer needs {@link blobUrl} to display one, main
 * needs {@link blobRelPath} to find its bytes and {@link parseBlobUrl} to
 * serve them, and both need {@link isImageMime} to make the same
 * inline-or-chip call. None of it touches disk.
 */

/** Bytes the app has taken custody of, addressed by content. */
export interface Blob {
  /** Lowercase hex sha256 of the bytes — the Blob's whole identity. */
  hash: string;
  /** IANA media type as observed at import (`image/png`, `application/pdf`, …). */
  mime: string;
  sizeBytes: number;
  /**
   * The basename the file had when the user handed it over, kept for display
   * and for deriving the materialized name. Never a path — a Blob's location
   * is its hash, and the original directory is not ours to remember.
   */
  originalName: string;
  /** Pixel dimensions when the Blob is an image we could measure; `null` otherwise. */
  width: number | null;
  height: number | null;
  createdAt: number;
}

/**
 * Where a Blob is attached. Exactly one owner is set — a Ticket (spec material
 * on the Ticket itself) or a Session (a file handed to the agent mid-chat).
 * Two explicit nullable owners rather than a generic `ownerKind`/`ownerId`
 * pair: there are two surfaces, a reader should be able to see both, and a
 * third would rather be a deliberate schema change than a new string value
 * nobody notices.
 */
export type BlobLink = {
  id: string;
  blobHash: string;
  label: string;
  createdAt: number;
} & ({ ticketId: string; sessionId: null } | { ticketId: null; sessionId: string });

/** The `volli-blob:` URL scheme the renderer loads a Blob's bytes over. */
export const BLOB_URL_SCHEME = "volli-blob";

/** A lowercase hex sha256: exactly 64 hex digits. */
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Whether `value` is a well-formed Blob hash. This is the ONLY guard the Blob
 * file store needs against path traversal, and unlike a
 * reject-`..`-and-separators check it is total: a 64-char hex string cannot
 * contain a separator, a dot, or anything else that means something to a
 * filesystem. Content-addressing buys the safety property outright — which is
 * why every path derivation below asserts this rather than sanitizing.
 */
export function isBlobHash(value: string): boolean {
  return BLOB_HASH_PATTERN.test(value);
}

/**
 * A Blob's path relative to the store root: `<first two hex chars>/<hash>`.
 * The two-character shard keeps any one directory from collecting every Blob
 * the user has ever attached, which some filesystems handle poorly and every
 * `ls` handles annoyingly.
 *
 * DURABLE: this derivation names bytes already on disk. Changing the shard
 * width or the separator does not error — it silently orphans every existing
 * Blob and re-imports them under new names.
 */
export function blobRelPath(hash: string): string {
  if (!isBlobHash(hash)) throw new Error(`Not a blob hash: ${JSON.stringify(hash)}`);
  return `${hash.slice(0, 2)}/${hash}`;
}

/** The `volli-blob:<hash>` URL that resolves to a Blob's bytes in the renderer. */
export function blobUrl(hash: string): string {
  if (!isBlobHash(hash)) throw new Error(`Not a blob hash: ${JSON.stringify(hash)}`);
  return `${BLOB_URL_SCHEME}:${hash}`;
}

/**
 * The hash a `volli-blob:` URL names, or `null` when `url` is not one or names
 * something that is not a hash. Returning `null` rather than throwing is what
 * lets the protocol handler answer a malformed request with a 400 instead of
 * taking the whole handler down — it is fed whatever the page asks for.
 */
export function parseBlobUrl(url: string): string | null {
  const prefix = `${BLOB_URL_SCHEME}:`;
  if (!url.startsWith(prefix)) return null;
  // Electron normalizes a `scheme:host` request into `scheme://host/`, so
  // tolerate the slashes and the trailing one the URL parser adds back.
  const rest = url.slice(prefix.length).replace(/^\/\//, "").replace(/\/$/, "");
  return isBlobHash(rest) ? rest : null;
}

/**
 * Whether a Blob's bytes can be handed to a model as image content. This is
 * the one predicate that splits the two halves of the pipeline: an image is
 * materialized into the workspace AND inlined at send time, everything else is
 * materialized and referenced by path only. It also decides presentation —
 * images render inline, every other type is a chip.
 */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * The largest image we will inline as model input. Providers cap this (5 MB at
 * Anthropic) and the failure is not a polite one: an oversized image that has
 * already entered durable history replays on every subsequent turn, so the
 * session stops accepting even plain text. We therefore cap on the way IN —
 * at import, before anything is written — rather than discovering it at send.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Inserts `-${n}` before the extension (`spec.png` → `spec-2.png`); an extensionless name gets it appended (`notes` → `notes-2`). */
function withCounterSuffix(fileName: string, n: number): string {
  const dotIndex = fileName.lastIndexOf(".");
  // No dot, or a dot at index 0 (a dotfile with no further extension, e.g.
  // `.env`) — treat as extensionless and append the counter at the end.
  if (dotIndex <= 0) return `${fileName}-${n}`;
  return `${fileName.slice(0, dotIndex)}-${n}${fileName.slice(dotIndex)}`;
}

/** One link plus the name its Blob was given by whoever supplied it. */
export interface NamedBlobLink {
  linkId: string;
  blobHash: string;
  label: string;
  originalName: string;
}

/**
 * The materialized on-disk file name for each link (link id → name), in the
 * given (already-chronological) order. Two links may name Blobs that share a
 * basename — two screenshots both called `spec.png`, or the very same Blob
 * linked twice with different labels — and the agent-facing names must be
 * stable and collision-free. So the FIRST link to use a given `originalName`
 * keeps it verbatim, and every later one gets a `-2`, `-3`, … counter inserted
 * before the extension. The counter skips over any name ALREADY assigned, so a
 * second `spec.png` alongside a verbatim `spec-2.png` becomes `spec-3.png`
 * rather than a duplicate — a duplicate would make the skip-if-exists
 * materialize silently drop one link's bytes.
 *
 * Deterministic: the same chronological input always produces the same
 * mapping, which is what lets a caller re-derive the paths for the brief
 * WITHOUT touching disk, and lets a pruned workspace be re-materialized to
 * exactly the names the transcript already mentions.
 */
/** The workspace-relative directory Blobs materialize into. */
export const SESSION_ATTACHMENTS_REL_DIR = ".volli/attachments";

/**
 * `harness-command.ts`'s `composeAttachmentsSection` input, derived from a
 * Session's links: each one's materialized relative path plus its label. Pure —
 * reused both when `blob-materialize.ts` has just copied the bytes AND when a
 * caller (a worktree kickoff command, `ticket.brief`) re-derives the same list
 * WITHOUT touching disk, since the naming is deterministic from the links alone.
 *
 * `urls` is always empty: link attachments are not part of VC-50, and the
 * formatter keeps its URL branch rather than being narrowed for a feature that
 * is deferred rather than cancelled.
 */
export function blobsSectionInput(links: readonly NamedBlobLink[]): {
  files: { relPath: string; label: string }[];
  urls: { url: string; label: string }[];
} {
  const names = materializedBlobNames(links);
  const files = links.map((link) => ({
    // Never misses: materializedBlobNames maps every link in the list it was given.
    relPath: `${SESSION_ATTACHMENTS_REL_DIR}/${names.get(link.linkId)!}`,
    label: link.label,
  }));
  return { files, urls: [] };
}

export function materializedBlobNames(links: readonly NamedBlobLink[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const link of links) {
    let candidate = link.originalName;
    for (let n = 2; taken.has(candidate); n += 1) {
      candidate = withCounterSuffix(link.originalName, n);
    }
    taken.add(candidate);
    names.set(link.linkId, candidate);
  }
  return names;
}
