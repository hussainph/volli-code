/**
 * The attachment thumbnails a composer shows above its input (VC-50).
 *
 * One shape for both kinds so the strip reads as a row of things rather than a
 * row of exceptions: every attachment is the same square tile. An image fills
 * its tile with itself, because the picture IS the label — no file name
 * identifies a screenshot as well as looking at it. Everything else fills the
 * same square with a card naming its type and file name, so a PDF beside two
 * screenshots still reads as one of three attached things.
 *
 * Images load over `volli-blob:`, which resolves through the Blob store rather
 * than the workspace — so a thumbnail is still there after the worktree it was
 * materialized into has been pruned.
 */
import * as React from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { blobUrl, type BlobLinkView } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { fileTypeLabel, formatFileSize, thumbKind } from "./attachment-model";

export interface AttachmentThumbProps {
  attachment: BlobLinkView;
  /** Absent makes the tile read-only — the transcript's copy of a sent message. */
  onRemove?: (attachment: BlobLinkView) => void;
  className?: string;
}

export function AttachmentThumb({
  attachment,
  onRemove,
  className,
}: AttachmentThumbProps): React.ReactElement {
  const kind = thumbKind(attachment.mime);
  const size = formatFileSize(attachment.sizeBytes);
  const detail = `${fileTypeLabel(attachment.originalName, attachment.mime)}${
    size === "" ? "" : ` · ${size}`
  }`;
  return (
    <div
      className={cn("group relative size-16 shrink-0", className)}
      // The full name lives in the tooltip rather than the tile: a tile wide
      // enough for `Screenshot 2026-08-18 at 10.31.44.png` is not a thumbnail.
      title={`${attachment.label} · ${detail}`}
    >
      {kind === "image" ? (
        <img
          src={blobUrl(attachment.blobHash)}
          alt={attachment.label}
          className="size-full rounded-md border border-border/70 object-cover"
          draggable={false}
        />
      ) : (
        <div
          aria-label={`${attachment.label} · ${detail}`}
          className="flex size-full flex-col justify-between rounded-md border border-border/70 bg-muted/40 p-1.5"
        >
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
            {fileTypeLabel(attachment.originalName, attachment.mime)}
          </span>
          {/* Two lines of the name, clipped. Enough to tell two PDFs apart,
              which is all this tile has to do. */}
          <span className="line-clamp-2 break-all text-[10px] leading-tight text-foreground/80">
            {attachment.originalName}
          </span>
        </div>
      )}
      {onRemove === undefined ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Remove ${attachment.label}`}
          onClick={() => onRemove(attachment)}
          // Always reachable by keyboard, only visible on hover or focus: a
          // permanent × on every tile turns a quiet strip into a busy one.
          className="absolute -right-1.5 -top-1.5 size-5 rounded-full border border-border bg-background p-0 opacity-0 shadow-raised transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </div>
  );
}

export interface AttachmentStripProps {
  attachments: readonly BlobLinkView[];
  onRemove?: (attachment: BlobLinkView) => void;
  className?: string;
}

/** Renders nothing at all when there is nothing attached — no empty row, no reserved space. */
export function AttachmentStrip({
  attachments,
  onRemove,
  className,
}: AttachmentStripProps): React.ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Attachments"
      className={cn("flex flex-wrap items-start gap-2", className)}
    >
      {attachments.map((attachment) => (
        <div role="listitem" key={attachment.linkId ?? attachment.blobHash}>
          <AttachmentThumb
            attachment={attachment}
            {...(onRemove === undefined ? {} : { onRemove })}
          />
        </div>
      ))}
    </div>
  );
}
