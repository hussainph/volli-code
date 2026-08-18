/**
 * The pure decisions behind an attachment thumbnail (VC-50).
 *
 * Beside the `.tsx` that draws it rather than inside it, so the gate can reach
 * the arithmetic — the same arrangement `ui/tab-focus.ts` and
 * `ai-elements/scroll-chaining.ts` use.
 */
import { isImageMime } from "@volli/shared";

/** How a thumbnail should draw: the picture itself, or a card standing in for it. */
export type ThumbKind = "image" | "file";

/**
 * Images preview as themselves; everything else gets a card.
 *
 * The split is `isImageMime` and nothing else, so a thumbnail and the send path
 * can never disagree about what an image is — the same predicate decides
 * whether bytes are inlined for the model.
 */
export function thumbKind(mime: string): ThumbKind {
  return isImageMime(mime) ? "image" : "file";
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
