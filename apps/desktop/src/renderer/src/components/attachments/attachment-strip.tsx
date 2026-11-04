/** Shared attachment cards for drafts, transcripts and queued messages. */
import * as React from "react";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FileZipIcon } from "@phosphor-icons/react/dist/csr/FileZip";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { BlobLinkView } from "@volli/shared";
import { AttachmentImage } from "./blob-read";

import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { cn } from "@renderer/lib/utils";
import { fileTypeLabel, formatFileSize, thumbKind } from "./attachment-model";

export type AttachmentState = "queued" | "uploading" | "failed";
/** State is supplied by the owner, never inferred from a missing image or blob. */
export type AttachmentCardView = BlobLinkView & { state?: AttachmentState };

function AttachmentGlyph({
  attachment,
  className,
}: {
  attachment: BlobLinkView;
  className: string;
}) {
  const Glyph =
    thumbKind(attachment.mime) === "image"
      ? ImageIcon
      : /\.(zip|tar|gz|tgz|7z|rar)$/i.test(attachment.originalName)
        ? FileZipIcon
        : /\.(pdf|md|txt|csv|json)$/i.test(attachment.originalName) ||
            attachment.mime.startsWith("text/")
          ? FileTextIcon
          : FileIcon;
  return <Glyph aria-hidden="true" className={className} />;
}

function detail(attachment: BlobLinkView): string {
  return [
    fileTypeLabel(attachment.originalName, attachment.mime),
    formatFileSize(attachment.sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

const stateLabels: Record<AttachmentState, string> = {
  queued: "Queued",
  uploading: "Uploading",
  failed: "Upload failed",
};

/** Longest name a card shows whole; longer names keep their start and the
 * distinguishing tail (with the extension) around one ellipsis. */
const NAME_FIT = 24;
const NAME_TAIL = 9;

export function middleTruncate(name: string, fit = NAME_FIT): string {
  if (name.length <= fit) return name;
  const tail = Math.min(NAME_TAIL, Math.floor(fit / 2));
  return `${name.slice(0, fit - tail - 1)}…${name.slice(-tail)}`;
}

/** One string, so the ellipsis sits flush; CSS truncation is only the
 * narrow-card fallback. The full name stays in the title and to readers. */
function Filename({ name, fit }: { name: string; fit?: number }) {
  return (
    <span className="block min-w-0 truncate text-label font-medium text-foreground" title={name}>
      <span aria-hidden="true">{middleTruncate(name, fit)}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}

function StateLabel({ state, name }: { state: AttachmentState; name: string }) {
  const Glyph = state === "failed" ? WarningCircleIcon : ClockIcon;
  return (
    <span
      role={state === "failed" ? "alert" : "status"}
      aria-label={`${name}: ${stateLabels[state]}`}
      className={cn(
        "flex items-center gap-1 text-label",
        state === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {state === "uploading" ? (
        <Spinner
          aria-hidden="true"
          role="presentation"
          aria-label={undefined}
          className="size-3 shrink-0 motion-reduce:animate-none"
        />
      ) : (
        <Glyph aria-hidden="true" weight="bold" className="size-3 shrink-0" />
      )}
      {stateLabels[state]}
    </span>
  );
}

export interface AttachmentThumbProps {
  attachment: AttachmentCardView;
  /** Absent makes the card read-only, as in a transcript. */
  onRemove?: (attachment: BlobLinkView) => void;
  className?: string;
}

export function AttachmentThumb({
  attachment,
  onRemove,
  className,
}: AttachmentThumbProps): React.ReactElement {
  const metadata = detail(attachment);
  return (
    <div
      className={cn(
        "group relative flex min-h-20 w-56 max-w-full min-w-0 items-center gap-2 rounded-md border border-border bg-card p-2",
        className,
      )}
      title={`${attachment.originalName} · ${metadata}${attachment.state ? ` · ${stateLabels[attachment.state]}` : ""}`}
    >
      {thumbKind(attachment.mime) === "image" &&
      attachment.state !== "uploading" &&
      attachment.state !== "failed" ? (
        <AttachmentImage
          hash={attachment.blobHash}
          alt={attachment.label}
          className="size-16 shrink-0 rounded-sm border border-border object-cover"
          draggable={false}
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-primary">
          <AttachmentGlyph attachment={attachment} className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <Filename name={attachment.originalName} />
        <span className="block text-label text-muted-foreground">{metadata}</span>
        {attachment.state ? (
          <StateLabel state={attachment.state} name={attachment.originalName} />
        ) : null}
      </span>
      {onRemove === undefined ? null : (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${attachment.label}`}
          onClick={() => onRemove(attachment)}
          className="absolute -right-1 -top-1 border border-border bg-background opacity-0 shadow-raised focus-visible:opacity-100 group-hover:opacity-100"
        >
          <XIcon aria-hidden="true" weight="bold" className="size-3" />
        </Button>
      )}
    </div>
  );
}

/** One named card by default, leaving room for the queued message and its actions. */
export function AttachmentThumbRow({
  attachments,
  max = 1,
  className,
}: {
  attachments: readonly AttachmentCardView[];
  max?: number;
  className?: string;
}): React.ReactElement | null {
  if (attachments.length === 0) return null;
  const shown = attachments.slice(0, Math.max(1, max));
  const hidden = attachments.slice(shown.length);
  return (
    <span
      className={cn("flex max-w-48 min-w-0 shrink items-center gap-1", className)}
      role="group"
      aria-label={`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}
    >
      {shown.map((attachment) => {
        const state = attachment.state ?? "queued";
        return (
          <span
            key={attachment.linkId ?? attachment.blobHash}
            title={`${attachment.originalName} · ${detail(attachment)} · ${stateLabels[state]}`}
            className="flex w-40 min-w-0 items-center gap-1 rounded-md border border-border bg-card p-1"
          >
            {thumbKind(attachment.mime) === "image" && state === "queued" ? (
              <AttachmentImage
                hash={attachment.blobHash}
                alt={attachment.label}
                className="size-4 shrink-0 rounded-sm object-cover"
                draggable={false}
              />
            ) : (
              <AttachmentGlyph attachment={attachment} className="size-4 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1">
              <Filename name={attachment.originalName} fit={18} />
              <span className="block text-label text-muted-foreground">{detail(attachment)}</span>
              <StateLabel state={state} name={attachment.originalName} />
            </span>
          </span>
        );
      })}
      {hidden.length > 0 ? (
        <span
          className="shrink-0 text-label text-muted-foreground"
          title={hidden
            .map(
              (attachment) =>
                `${attachment.originalName} · ${detail(attachment)} · ${stateLabels[attachment.state ?? "queued"]}`,
            )
            .join("\n")}
          aria-label={`${hidden.length} more attachments: ${hidden.map((attachment) => attachment.originalName).join(", ")}`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}

export interface AttachmentStripProps {
  attachments: readonly AttachmentCardView[];
  onRemove?: (attachment: BlobLinkView) => void;
  className?: string;
}

/** Empty strips reserve no space. */
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
      className={cn("flex min-w-0 flex-wrap items-start gap-2", className)}
    >
      {attachments.map((attachment) => (
        <div
          role="listitem"
          className="max-w-full min-w-0"
          key={attachment.linkId ?? attachment.blobHash}
        >
          <AttachmentThumb
            attachment={attachment}
            {...(onRemove === undefined ? {} : { onRemove })}
          />
        </div>
      ))}
    </div>
  );
}
