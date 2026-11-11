import * as React from "react";
import { SuccessIcon, ChevronRightIcon, ErrorIcon } from "@renderer/components/ui/icon";
import { Shimmer } from "@renderer/components/ui/ai-elements/shimmer";
import { Popover, PopoverAnchor, PopoverContent } from "@renderer/components/ui/popover";
import { TitleReveal } from "@renderer/components/ui/title-reveal";
import { useStopFollowing } from "@renderer/components/ui/ai-elements/conversation";
import {
  workDurationLabel,
  activityStatus,
  type TranscriptWorkWindow,
  type SummarySegment,
} from "@volli/session-presentation";
import "./transcript-presentation.css";

/** The receipt is the only transcript hover preview; pointer focus never owns it. */
export function WorkReceipt({
  work,
  summary,
  open,
  onToggle,
  glyph,
  running = false,
}: {
  work: TranscriptWorkWindow;
  summary: readonly SummarySegment[];
  open: boolean;
  onToggle(): void;
  glyph?: React.ReactNode;
  running?: boolean;
}) {
  const [preview, setPreview] = React.useState(false);
  const pointerFocus = React.useRef(false);
  const dismissed = React.useRef(false);
  const stopFollowing = useStopFollowing();
  const unresolved = work.rows.filter((row) =>
    row.kind === "reasoning"
      ? row.streaming
      : ["running", "pending"].includes(activityStatus(row.part)),
  ).length;
  const full = [
    summary.map((segment) => segment.text).join(" · ") || "Thinking",
    unresolved > 0 ? `${unresolved} unresolved` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const short = workDurationLabel(work);
  // Opening reveals the breakdown below, never replaces the parent's gist.
  const label = short;
  const outcomes = summary.filter((segment) => segment.tone !== "neutral");
  const supplemental = outcomes.filter((segment) => !label.split(" · ").includes(segment.text));
  const close = () => {
    dismissed.current = true;
    setPreview(false);
  };
  return (
    <Popover
      open={!open && preview}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          data-slot="activity-bundle-header"
          className="transcript-work-summary"
          aria-expanded={open}
          onPointerEnter={() => {
            dismissed.current = false;
            if (!open) setPreview(true);
          }}
          onPointerLeave={() => setPreview(false)}
          onPointerDown={() => {
            pointerFocus.current = true;
            close();
          }}
          onFocus={() => {
            if (!pointerFocus.current && !dismissed.current && !open) setPreview(true);
          }}
          onBlur={() => {
            pointerFocus.current = false;
            close();
            dismissed.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          onClick={() => {
            if (window.getSelection()?.toString()) return;
            close();
            if (!open) stopFollowing();
            onToggle();
          }}
        >
          <span className="transcript-status-slot">
            {glyph ??
              (outcomes.some((outcome) => outcome.tone === "danger") ? (
                <ErrorIcon aria-hidden className="size-3.5 text-destructive" />
              ) : (
                <SuccessIcon aria-hidden className="size-3.5" />
              ))}
          </span>
          {running ? (
            <Shimmer as="span" className="min-w-0 truncate">
              {label}
            </Shimmer>
          ) : (
            <TitleReveal text={label} automatic={false} className="min-w-0 truncate" />
          )}
          {!open && (supplemental.length > 0 || unresolved > 0) ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-ui text-foreground">
              {outcomes.some((outcome) => outcome.tone === "danger") ? (
                <ErrorIcon aria-hidden className="size-4 shrink-0 text-destructive" />
              ) : null}
              {[
                ...supplemental.map((outcome) => outcome.text),
                ...(unresolved > 0 ? [`${unresolved} unresolved`] : []),
              ].join(" · ")}
            </span>
          ) : null}
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0"
            style={{ transform: open ? "rotate(90deg)" : undefined }}
          />
        </button>
      </PopoverAnchor>
      <PopoverContent
        className="pointer-events-none"
        side="top"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={close}
      >
        <bdi dir="auto">{full}</bdi>
      </PopoverContent>
    </Popover>
  );
}
