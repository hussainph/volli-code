/**
 * Host notices, drawn from the portable Session Surface Model (VC-330).
 *
 * Writers keep the model-facing message in-band; `@volli/session-presentation`
 * turns its shared semantic metadata into one of these rows before this client
 * sees it. The renderer chooses components only. It does not parse transcript
 * metadata or repeat host/client protocol vocabulary.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { UsersThreeIcon } from "@phosphor-icons/react/dist/csr/UsersThree";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";

import {
  browserHoldNoticeCopy,
  subagentNoticeCopy,
  type BrowserHoldNotice,
  type SubagentNotice,
  type TranscriptHostNotice,
  type UnknownHostNotice,
} from "@volli/session-presentation";

import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import { cn } from "@renderer/lib/utils";

const GLYPH_CLASS = "size-3.5 shrink-0";

function SubagentNoticeGlyph({ state }: { state: SubagentNotice["state"] }) {
  switch (state) {
    case "completed":
    case "stopped":
      return <UsersThreeIcon aria-hidden className={cn(GLYPH_CLASS, "text-muted-foreground")} />;
    case "interrupted":
    case "timed-out":
      return (
        <WarningIcon aria-hidden className={cn(GLYPH_CLASS, "text-attention")} weight="fill" />
      );
    case "failed":
      return (
        <XCircleIcon aria-hidden className={cn(GLYPH_CLASS, "text-destructive")} weight="fill" />
      );
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
  const historicalNote =
    childSessionId === null
      ? `${copy.note} Answer: volli session answer ${notice.sessionHandle}`
      : copy.note;
  return (
    <div
      className="not-prose flex min-w-0 flex-col gap-1"
      title={`${copy.headline} — ${copy.state}. ${historicalNote}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <SubagentNoticeGlyph state={notice.state} />
        <span className="min-w-0 truncate font-medium">{copy.headline}</span>
        <span className="shrink-0 text-muted-foreground">{copy.state}</span>
        <Separator aria-hidden className="min-w-4 flex-1" />
        {onOpenSession === undefined || childSessionId === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            title="Open the Subagent Session"
            onClick={() => onOpenSession(childSessionId)}
          >
            <ArrowSquareOutIcon aria-hidden className="size-3.5" />
            Open
          </Button>
        )}
      </div>
      <p className="truncate text-ui text-muted-foreground/70">{historicalNote}</p>
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
    <div
      className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground"
      title={`Browser Tab ${notice.tabId} — ${copy.headline} — ${copy.note}`}
    >
      <BrowserIcon aria-hidden className={GLYPH_CLASS} />
      <span className="min-w-0 truncate font-medium text-foreground">{copy.headline}</span>
      <Separator aria-hidden className="min-w-4 flex-1" />
      <span className="min-w-0 truncate">{copy.note}</span>
    </div>
  );
});

export const UnknownHostNoticeRow = React.memo(function UnknownHostNoticeRow({
  notice,
}: {
  notice: UnknownHostNotice;
}) {
  return (
    <div
      className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground"
      title={notice.text}
    >
      <WarningIcon aria-hidden className={cn(GLYPH_CLASS, "text-attention")} weight="fill" />
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
    case "unknown":
      return <UnknownHostNoticeRow notice={notice} />;
  }
});
