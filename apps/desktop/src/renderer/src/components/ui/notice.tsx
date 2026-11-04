import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { toastError } from "@renderer/lib/toast";

export type NoticeTone = "neutral" | "error" | "positive" | "warning";

const NOTICE_TONE: Record<NoticeTone, string> = {
  neutral: "border-border bg-muted/30 text-muted-foreground",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  positive: "border-border bg-muted/30 text-muted-foreground",
  warning: "border-border bg-muted/30 text-muted-foreground",
};
const NOTICE_ICON = {
  neutral: InfoIcon,
  error: XCircleIcon,
  positive: CheckCircleIcon,
  warning: WarningCircleIcon,
};

// Retained for this renderer run, across page unmounts. An explicit key names
// the occurrence and scope; a new occurrence must use a new key. Never hide a
// required fault just because another surface printed the same words.
const dismissedNotices = new Set<string>();

/** Required messages stay visible; transient occurrences may opt into durable dismissal. */
export function Notice({
  tone = "neutral",
  icon: Icon = NOTICE_ICON[tone],
  title,
  detail,
  actions,
  layout = "row",
  truncate = false,
  expandable = tone === "error" || truncate,
  copyText,
  onDismiss,
  dismissalKey,
  announce = false,
  hoverTitle,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  tone?: NoticeTone;
  icon?: React.ComponentType<React.ComponentProps<PhosphorIcon>>;
  title: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  layout?: "row" | "stack";
  /** Legacy narrow-column intent; now clamped with a way to read the whole message. */
  truncate?: boolean;
  /** Clamp long messages to two lines, with a disclosure outside the live region. */
  expandable?: boolean;
  /** Override for rich messages. String title/detail errors are copyable automatically. */
  copyText?: string;
  /** Caller-owned dismissal. Use dismissalKey when the message can remount on navigation. */
  onDismiss?: () => void;
  /** Stable, scoped occurrence identity. Opts into dismissal for this app run. */
  dismissalKey?: string;
  announce?: boolean;
  hoverTitle?: string;
}) {
  const [dismissedKey, setDismissedKey] = React.useState<string>();
  const [expanded, setExpanded] = React.useState(false);
  const [overflowing, setOverflowing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const messageRef = React.useRef<HTMLDivElement>(null);
  const messageId = React.useId();
  const plainText =
    copyText ?? [title, detail].filter((part) => typeof part === "string").join("\n");
  const stacked = layout === "stack";

  React.useEffect(() => {
    setExpanded(false);
    setCopied(false);
  }, [title, detail]);
  React.useLayoutEffect(() => {
    const node = messageRef.current;
    if (!expandable || !node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [expandable, expanded, title, detail]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
    } catch {
      toastError("Couldn't copy the notice");
    }
  }

  if (dismissalKey && (dismissedKey === dismissalKey || dismissedNotices.has(dismissalKey))) {
    return null;
  }
  function dismiss() {
    if (dismissalKey) {
      // Keep the run-local memory bounded, without storing error details on disk.
      if (dismissedNotices.size >= 500)
        dismissedNotices.delete(dismissedNotices.values().next().value!);
      dismissedNotices.add(dismissalKey);
      setDismissedKey(dismissalKey);
    }
    onDismiss?.();
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap gap-2 rounded-container border",
        stacked ? "items-start p-4" : "items-start px-4 py-2",
        NOTICE_TONE[tone],
        className,
      )}
      {...rest}
    >
      {/* Centre the glyph on the title's line box, not the entire message or
          its recovery controls. Details and wrapping keep the same first line. */}
      <span data-slot="notice-icon" className="flex h-5 shrink-0 items-center">
        <Icon
          aria-hidden
          weight={Icon === NOTICE_ICON[tone] ? "fill" : undefined}
          className={cn("size-4", tone === "positive" && "text-positive")}
        />
      </span>
      <div className="min-w-0 flex-1" title={hoverTitle}>
        {/* Only the message is announced: controls must remain siblings. */}
        <div
          ref={messageRef}
          id={messageId}
          className={cn(
            "text-ui [overflow-wrap:anywhere]",
            expandable && !expanded && "line-clamp-2",
          )}
          {...(announce
            ? { role: "status", "aria-live": "polite" as const, "aria-atomic": true }
            : {})}
        >
          <p
            className={cn(
              "font-medium",
              detail !== undefined && tone !== "error" && "text-foreground",
            )}
          >
            {title}
          </p>
          {detail === undefined ? null : <p className="mt-1 text-ui">{detail}</p>}
        </div>
        {(expandable && (overflowing || expanded)) || (tone === "error" && plainText) ? (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {expandable && (overflowing || expanded) ? (
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={expanded}
                aria-controls={messageId}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : "Show more"}
              </Button>
            ) : null}
            {tone === "error" && plainText ? (
              <Button size="xs" variant="ghost" onClick={() => void copy()}>
                <CopyIcon />
                {copied ? "Copied" : "Copy error"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {stacked && actions !== undefined ? (
          <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>
        ) : null}
      </div>
      {!stacked && actions !== undefined ? (
        <div className="flex max-w-full flex-wrap items-center gap-2 self-center">{actions}</div>
      ) : null}
      {onDismiss || dismissalKey ? (
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss notice" onClick={dismiss}>
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
