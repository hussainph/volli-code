/**
 * Host notices, drawn from the portable Session Surface Model (VC-330).
 *
 * Writers keep the model-facing message in-band; `@volli/session-presentation`
 * turns its shared semantic metadata into one of these rows before this client
 * sees it. The renderer chooses components only. It does not parse transcript
 * metadata or repeat host/client protocol vocabulary.
 */
import * as React from "react";
import {
  ExternalIcon,
  BrowserIcon,
  PreviewIcon,
  TerminalIcon,
  TeamIcon,
  WarningIcon,
  StopCircleIcon,
  ErrorIcon,
} from "@renderer/components/ui/icon";

import {
  browserHoldNoticeCopy,
  shellNoticeCopy,
  subagentNoticeCopy,
  watchNoticeCopy,
  type BrowserHoldNotice,
  type SubagentNotice,
  type TranscriptHostNotice,
  type UnknownHostNotice,
  type WatchNotice,
} from "@volli/session-presentation";

import type { BackgroundShellHostNotice } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import { cn } from "@renderer/lib/utils";

const GLYPH_CLASS = "size-3.5 shrink-0";

function SubagentNoticeGlyph({ state }: { state: SubagentNotice["state"] }) {
  switch (state) {
    case "completed":
      return <TeamIcon aria-hidden className={cn(GLYPH_CLASS, "text-muted-foreground")} />;
    case "stopped":
      return <StopCircleIcon aria-hidden className={cn(GLYPH_CLASS, "text-muted-foreground")} />;
    case "interrupted":
    case "timed-out":
      return <WarningIcon aria-hidden className={cn(GLYPH_CLASS, "text-attention")} />;
    case "failed":
      return <ErrorIcon aria-hidden className={cn(GLYPH_CLASS, "text-destructive")} />;
  }
}

export const SubagentNoticeRow = React.memo(function SubagentNoticeRow({
  notice,
  onOpenSession,
}: {
  notice: SubagentNotice;
  onOpenSession?(sessionId: string): void;
}) {
  const copy = subagentNoticeCopy(notice);
  const childSessionId = notice.childSessionId;
  return (
    <div className="not-prose flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <SubagentNoticeGlyph state={notice.state} />
        <span className="min-w-0 truncate font-medium">
          <bdi dir="auto">{copy.headline}</bdi>
        </span>
        <span className="shrink-0 text-muted-foreground">
          {copy.state === "done" ? "finished" : copy.state}
          {copy.cause ? ` · ${copy.cause}` : ""}
        </span>
        <Separator aria-hidden className="min-w-4 flex-1" />
        {onOpenSession === undefined || childSessionId === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => onOpenSession(childSessionId)}
          >
            <ExternalIcon aria-hidden className="size-3.5" />
            Open
          </Button>
        )}
      </div>
    </div>
  );
});

export const BrowserHoldNoticeRow = React.memo(function BrowserHoldNoticeRow({
  notice,
}: {
  notice: BrowserHoldNotice;
}) {
  const copy = browserHoldNoticeCopy(notice);
  return (
    <div className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <BrowserIcon aria-hidden className={GLYPH_CLASS} />
      <span className="min-w-0 truncate font-medium text-foreground">{copy.headline}</span>
      <Separator aria-hidden className="min-w-4 flex-1" />
      <span className="min-w-0 truncate">{copy.state}</span>
    </div>
  );
});

export const WatchNoticeRow = React.memo(function WatchNoticeRow({
  notice,
}: {
  notice: WatchNotice;
}) {
  const copy = watchNoticeCopy(notice);
  return (
    <div className="not-prose flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <PreviewIcon aria-hidden className={cn(GLYPH_CLASS, "text-muted-foreground")} />
        <span className="min-w-0 truncate font-medium">{copy.headline}</span>
        <Separator aria-hidden className="min-w-4 flex-1" />
      </div>
      {copy.lines.length > 1 ? <span className="sr-only">{copy.lines.join(" · ")}</span> : null}
    </div>
  );
});

/**
 * A background shell the Session started exited, or printed the line it asked
 * to be told about (VC-495). Quiet on purpose, like the other host rows: the
 * glyph carries the outcome, with semantic ink on attention and failure.
 * The state remains in the accessible receipt and hover text.
 */
export const ShellNoticeRow = React.memo(function ShellNoticeRow({
  notice,
}: {
  notice: BackgroundShellHostNotice;
}) {
  const copy = shellNoticeCopy(notice);
  return (
    <div className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
      {notice.event === "exited" && notice.byPerson ? (
        <StopCircleIcon aria-hidden className={GLYPH_CLASS} />
      ) : notice.event === "exited" &&
        ((notice.code !== null && notice.code !== 0) || notice.signal !== null) ? (
        <ErrorIcon aria-hidden className={cn(GLYPH_CLASS, "text-destructive")} />
      ) : (
        <TerminalIcon aria-hidden className={GLYPH_CLASS} />
      )}
      <span className="min-w-0 truncate font-medium text-foreground">{copy.headline}</span>
      <span className="sr-only">{copy.state}</span>
      <Separator aria-hidden className="min-w-4 flex-1" />
      <span className="min-w-0 truncate text-muted-foreground/70">{copy.note}</span>
    </div>
  );
});

export const UnknownHostNoticeRow = React.memo(function UnknownHostNoticeRow({
  notice,
}: {
  notice: UnknownHostNotice;
}) {
  return (
    <div className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <WarningIcon aria-hidden className={cn(GLYPH_CLASS, "text-attention")} />
      <span className="shrink-0 font-medium text-foreground">Volli</span>
      <Separator aria-hidden className="min-w-4 flex-1" />
      <span className="min-w-0 truncate">{notice.text}</span>
    </div>
  );
});

export const HostNoticeRow = React.memo(function HostNoticeRow({
  notice,
  onOpenSession,
}: {
  notice: TranscriptHostNotice;
  onOpenSession?(sessionId: string): void;
}) {
  switch (notice.kind) {
    case "subagent":
      return (
        <SubagentNoticeRow
          notice={notice}
          {...(onOpenSession === undefined ? {} : { onOpenSession })}
        />
      );
    case "browser-hold":
      return <BrowserHoldNoticeRow notice={notice} />;
    case "watch":
      return <WatchNoticeRow notice={notice} />;
    case "background-shell":
      return <ShellNoticeRow notice={notice} />;
    case "unknown":
      return <UnknownHostNoticeRow notice={notice} />;
  }
});
