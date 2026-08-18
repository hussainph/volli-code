/**
 * The pure decisions behind an attachment thumbnail (VC-50).
 *
 * Beside the `.tsx` that draws it rather than inside it, so the gate can reach
 * the arithmetic — the same arrangement `ui/tab-focus.ts` and
 * `ai-elements/scroll-chaining.ts` use.
 */
import { isImageMime, parseBlobUrl, type BlobLinkView } from "@volli/shared";

/** How a thumbnail should draw: the picture itself, or a card standing in for it. */
export type ThumbKind = "image" | "file";

/**
 * Images preview as themselves; everything else gets a card.
 *
 * The split is `isImageMime` — presentation's predicate, deliberately wider
 * than the send path's `isInlinableImageMime`. An SVG previews fine in an
 * `<img>` and reaches the model as a path ref rather than pixels; the
 * thumbnail shows what the file IS, not what the provider will take.
 */
export function thumbKind(mime: string): ThumbKind {
  return isImageMime(mime) ? "image" : "file";
}

/**
 * The little of an AI SDK message part the transcript's attachment row reads.
 * Structural (like shared's `UIMessageLike`) so this stays a pure function of
 * data rather than of the `ai` package.
 */
export interface FilePartLike {
  type: string;
  url?: string;
  mediaType?: string;
  filename?: string;
}

/**
 * The attachments a sent message's parts carry, as the view shape the
 * thumbnail strip draws (VC-50).
 *
 * A sent message is its own record: the part holds the `volli-blob:` URL, the
 * media type and the file name, and that is everything a read-only thumb
 * needs — so the transcript renders from the message alone, with no fetch,
 * exactly as it must for a Session whose attachment rows were since removed.
 * `sizeBytes` is `NaN` ("unknown", which `formatFileSize` renders as
 * nothing) rather than a fake zero — the part does not carry a size, and the
 * tooltip should not invent one.
 *
 * Parts that are not `volli-blob:` file parts are skipped, not rejected: the
 * transcript is durable and a part shape this build does not know is not a
 * reason to drop the ones it does.
 */
export function transcriptAttachments(parts: readonly FilePartLike[]): BlobLinkView[] {
  const views: BlobLinkView[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.type !== "file" || typeof part.url !== "string") continue;
    const hash = parseBlobUrl(part.url);
    // One thumb per Blob, however many parts name it — the strip keys rows by
    // hash (a transcript view has no link id), and the same picture twice says
    // nothing the once does not.
    if (hash === null || seen.has(hash)) continue;
    seen.add(hash);
    const name = part.filename ?? "attachment";
    views.push({
      linkId: null,
      blobHash: hash,
      label: name,
      originalName: name,
      mime: part.mediaType ?? "application/octet-stream",
      sizeBytes: Number.NaN,
    });
  }
  return views;
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * A file size a person can read at a glance: `840 B`, `12.4 KB`, `3.1 MB`.
 *
 * Whole numbers below a kilobyte (there is no such thing as 0.4 of a byte) and
 * one decimal above it, which is the precision that makes "is this near the
 * 5 MB ceiling?" answerable without making the chip wider than the file name.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} ${UNITS[unit]}` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * The short type label a file card shows under its name — `PDF`, `ZIP`, `PNG`.
 *
 * Derived from the file name rather than the media type, because that is the
 * word the person already has for this file. An extensionless name falls back
 * to the media type's subtype, and then to `FILE`, so the card is never blank.
 */
export function fileTypeLabel(originalName: string, mime: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot > 0 && dot < originalName.length - 1) {
    return originalName.slice(dot + 1).toUpperCase();
  }
  const subtype = mime.split("/")[1];
  return subtype === undefined || subtype.length === 0 ? "FILE" : subtype.toUpperCase();
}
