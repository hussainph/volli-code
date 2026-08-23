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
 * serve them. {@link isImageMime} makes the picture-or-card presentation
 * call; {@link isInlinableImageMime} — deliberately narrower — makes the
 * may-the-model-see-it call. None of it touches disk.
 */

import { isExpressibleRefPath } from "./file-ref";

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
 * Whether a Blob is an image for PRESENTATION: thumbnails render the picture
 * itself, everything else renders as a card. Presentation only — whether the
 * bytes may be handed to a model is {@link isInlinableImageMime}, and the two
 * deliberately disagree about an SVG: it previews fine in an `<img>`, and no
 * provider accepts it as image input.
 */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * The image media types a provider will actually take as base64 image input.
 * Anthropic's documented set, which is also the floor across providers —
 * Pi passes `mimeType` verbatim as the wire `media_type`, so anything outside
 * this list is a guaranteed 400 at the API.
 */
const INLINABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Whether a Blob's bytes can be handed to a model as image content. This is
 * the one predicate that splits the two halves of the pipeline: an inlinable
 * image is materialized into the workspace AND inlined at send time,
 * everything else is materialized and referenced by path only.
 *
 * STRICTER than {@link isImageMime}, and the gap is load-bearing: an
 * `image/svg+xml` or `image/heic` that inlined would be refused by the
 * provider — and because an inlined image persists into Pi's recovery sidecar
 * and replays on every later turn, ONE such attachment would fail every turn
 * after it, which is exactly the wedge (anthropics/claude-code #8202 and kin)
 * this design exists to prevent. An unknown image type degrades to the
 * materialized path ref instead, which the agent can still open with a tool.
 */
export function isInlinableImageMime(mime: string): boolean {
  return INLINABLE_IMAGE_MIMES.has(mime);
}

/**
 * The largest image we will inline as model input. Providers cap this (5 MB at
 * Anthropic) and the failure is not a polite one: an oversized image that has
 * already entered durable history replays on every subsequent turn, so the
 * session stops accepting even plain text. We therefore cap on the way IN —
 * at import, before anything is written — rather than discovering it at send.
 * Applies to {@link isInlinableImageMime} types only: nothing else can inline,
 * so nothing else can enter history, and its size is a disk question.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The most inlined image data one Session may accumulate across all its turns.
 *
 * {@link MAX_INLINE_IMAGE_BYTES} bounds a single image; this bounds the
 * conversation. The two are not the same guard, and only having the first is
 * precisely the gap behind the Claude Code reports: no one image was absurd,
 * but nothing stopped a session collecting enough of them that replaying the
 * history became the problem. Inlined bytes reach Pi's JSONL recovery sidecar,
 * which is re-read on every attach, so an unbounded session degrades a little
 * further with each screenshot until it stops working at all.
 *
 * Enforced at attach against the Session's already-linked image Blobs, so the
 * refusal names a number a person can act on while they still have the file in
 * hand.
 */
export const MAX_SESSION_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Whether one more image of `candidateBytes` fits a Session that has already
 * inlined `usedBytes`. Pure so both the attach affordance and the command that
 * performs the attach can ask the same question and never disagree.
 */
export function fitsSessionImageBudget(usedBytes: number, candidateBytes: number): boolean {
  return usedBytes + candidateBytes <= MAX_SESSION_INLINE_IMAGE_BYTES;
}

/**
 * What a Blob link looks like to the renderer: the link, plus the few Blob
 * columns a chip or a preview needs. Everything else the UI wants is derived
 * from these by pure helpers both sides already share — {@link isImageMime}
 * decides inline-or-chip, {@link blobUrl} addresses the bytes — so the wire
 * shape carries no field that could disagree with them.
 */
export interface BlobLinkView {
  /**
   * The `blob_links` row, or `null` for a Blob that is imported but not yet
   * attached to anything — a file added to a Ticket that has not been created.
   * Such a Blob is real, addressable and previewable; only its owner is
   * pending. Collection reclaims it if the draft is abandoned.
   */
  linkId: string | null;
  blobHash: string;
  label: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
}

/**
 * A defensive read of one {@link BlobLinkView}, for values that crossed a
 * persistence boundary — a chat draft's strip, a held message's files, a
 * Ticket-composer draft. Anything but the exact shape (with a real hash) is
 * not an attachment, and a hydration site drops it rather than the draft it
 * rode in on — the same stance `isPromptResource` takes for skill bodies.
 */
export function isBlobLinkView(value: unknown): value is BlobLinkView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return (
    (view["linkId"] === null || typeof view["linkId"] === "string") &&
    typeof view["blobHash"] === "string" &&
    isBlobHash(view["blobHash"]) &&
    typeof view["label"] === "string" &&
    typeof view["originalName"] === "string" &&
    typeof view["mime"] === "string" &&
    typeof view["sizeBytes"] === "number" &&
    Number.isFinite(view["sizeBytes"])
  );
}

/**
 * One image handed to a model as input for a single turn.
 *
 * `data` is raw base64 with no `data:` prefix, matching Pi's `ImageContent`.
 * This value is built at send time and thrown away after; it is never written
 * to `session_events`, the transcript artifact, or anywhere else durable. The
 * durable record of an attached image is its `volli-blob:` hash, which is a
 * few dozen bytes and cannot grow a conversation the way a replayed base64
 * block can.
 */
export interface RuntimeImageInput {
  data: string;
  mimeType: string;
}

/**
 * The little of an AI SDK `UIMessage` that attachment handling actually reads.
 *
 * Structural rather than the real `UIMessage`, so main-process modules can be
 * tested without the `ai` package and so a part shape this build does not know
 * about travels through untouched instead of failing a parse.
 */
export interface UIMessageLike {
  parts: readonly { type: string; url?: string; mediaType?: string; filename?: string }[];
}

/**
 * What attaching a file should actually do, given where it came from.
 *
 * Attach and the `@path` picker overlap on repository files, and they are not
 * the same promise: `@` names the live file, while a snapshot is frozen bytes
 * materialized under `.volli/attachments/`, which is gitignored and rebuilt
 * from the Blob store on every ensure. An agent that edits the snapshot loses
 * the edit silently, so a file that CAN be named live is named live.
 *
 * Images are the exception, and only additively: Pi cannot see a path, so a
 * repository image is named live AND snapshotted, giving the agent the real
 * file to edit and the model the pixels to look at.
 *
 * `repoRelPath` is `null` whenever the file has no nameable home in the
 * project — outside every project root, or pasted from the clipboard and never
 * on disk at all. Such a file can only be a snapshot.
 */
export type AttachResolution = "ref" | "snapshot" | "ref-and-snapshot";

export function resolveAttachment(repoRelPath: string | null, mime: string): AttachResolution {
  // Not in the project, or in it under a name the ref grammar cannot express
  // (`isExpressibleRefPath` rejects spaces, so `docs/design notes.pdf` has no
  // `@` form). Inserting a ref we cannot parse back would degrade to plain
  // text, which is worse than a snapshot.
  if (repoRelPath === null || !isExpressibleRefPath(repoRelPath)) return "snapshot";
  // Inlinable only: the second half of ref-and-snapshot exists so the model
  // can see the pixels, and a repo SVG's pixels are exactly what a provider
  // refuses — snapshotting it would buy a frozen copy nobody can use over the
  // live file the ref already names.
  return isInlinableImageMime(mime) ? "ref-and-snapshot" : "ref";
}

/** The `app_state` row holding the new-Ticket composer's draft. SHARED BETWEEN PROCESSES: the renderer writes it (`board/new-ticket/draft.ts`) and main reads it at boot to keep the draft's unowned Blobs alive — see {@link draftAttachmentHashes}. */
export const NEW_TICKET_DRAFT_APP_STATE_KEY = "volli:new-ticket-draft";

/**
 * The Blob hashes a stored new-Ticket draft still names, for boot-time
 * collection to retain (VC-137).
 *
 * A Ticket-composer draft's files are imported the moment they are chosen —
 * eagerly, so an oversized one is refused while the file is still in hand —
 * which leaves them as UNOWNED Blobs until the Ticket exists to link them.
 * Collection reclaims exactly that class at boot… which would also reclaim a
 * draft's own files the moment the app relaunched, silently turning a
 * persisted attachment into a broken thumbnail. So the sweep skips whatever
 * the stored draft names.
 *
 * Pure and defensive: a malformed or absent value simply retains nothing, so a
 * hand-edited row can at worst leak bytes (collected once the draft is fixed or
 * cleared), never crash a boot.
 */
export function draftAttachmentHashes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const draft = (parsed as Record<string, unknown>)["draft"];
  if (typeof draft !== "object" || draft === null) return [];
  const attachments = (draft as Record<string, unknown>)["attachments"];
  if (!Array.isArray(attachments)) return [];
  const hashes: string[] = [];
  for (const entry of attachments) {
    if (typeof entry !== "object" || entry === null) continue;
    const hash = (entry as Record<string, unknown>)["blobHash"];
    if (typeof hash === "string" && isBlobHash(hash)) hashes.push(hash);
  }
  return hashes;
}

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
