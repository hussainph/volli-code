import * as React from "react";
import { ClockIcon, ChevronRightIcon, ErrorIcon } from "@renderer/components/ui/icon";
import { Popover, PopoverAnchor, PopoverContent } from "@renderer/components/ui/popover";
import { TitleReveal } from "@renderer/components/ui/title-reveal";
import { useStopFollowing } from "@renderer/components/ui/ai-elements/conversation";
import {
  workDurationLabel,
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
}: {
  work: TranscriptWorkWindow;
  summary: readonly SummarySegment[];
  open: boolean;
  onToggle(): void;
}) {
  const [preview, setPreview] = React.useState(false);
  const [revealTarget, setRevealTarget] = React.useState<string | null>(null);
  const pointerFocus = React.useRef(false);
  const dismissed = React.useRef(false);
  const stopFollowing = useStopFollowing();
  const full = summary.map((segment) => segment.text).join(" · ") || "Thinking";
  const short = workDurationLabel(work);
  const label = open ? full : short;
  const outcomes = summary.filter((segment) => segment.tone !== "neutral");
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
          onClick={(event) => {
            if (window.getSelection()?.toString()) return;
            close();
            if (!open) stopFollowing();
            setRevealTarget(event.detail > 0 ? (open ? short : full) : null);
            onToggle();
          }}
        >
          <span className="transcript-clock-slot">
            <ClockIcon aria-hidden className="size-4" />
          </span>
          <TitleReveal
            text={label}
            automatic={revealTarget === label}
            className="min-w-0 truncate"
          />
          {!open && outcomes.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-ui text-foreground">
              {outcomes.some((outcome) => outcome.tone === "danger") ? (
                <ErrorIcon aria-hidden className="size-4 shrink-0 text-destructive" />
              ) : null}
              {outcomes.map((outcome) => outcome.text).join(" · ")}
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
