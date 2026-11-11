/**
 * The compaction boundary, drawn.
 *
 * What it says and where it sits are `chat/compaction-boundary.ts`'s; this is
 * only what it looks like — the same split every other row in the transcript is
 * built on.
 *
 * TWO DRESSES, and the difference is the fact itself rather than a severity
 * ramp. A compaction that happened DIVIDES the conversation — from here down the
 * model is working from a summary of what is above — so it wears a rule, which
 * is the one thing in this transcript that means "boundary" and the reason no
 * other row has one. A compaction that failed divides nothing: the summary was
 * never written and the context is exactly as it was, so it is a line like any
 * other quiet receipt, carrying the executor's own words about why. A rule there
 * would draw a seam that does not exist.
 *
 * Memoized on one stable object, which is the whole of its props. This sits in
 * the plane's own render, and the plane renders on every streamed frame of every
 * turn; a compaction moves once or twice in a Session.
 */
import * as React from "react";
import { CollapseVerticalIcon, WarningIcon } from "@renderer/components/ui/icon";

import {
  compactionBoundaryCopy,
  type LiveTranscriptCompaction,
  type TranscriptCompaction,
} from "@volli/session-presentation";
import { Separator } from "@renderer/components/ui/separator";
import { Spinner } from "@renderer/components/ui/spinner";

/**
 * A live, intentionally temporary counterpart to {@link CompactionBoundary}.
 *
 * It is a card rather than a rule because nothing has been rewritten yet. The
 * finished boundary remains the durable record; this only makes the otherwise
 * silent wait obvious while the summary model is working.
 *
 * The reason is on the face of it, not in a tooltip: the two waits this exists
 * to explain — "did my /compact land?" and "why has it stalled by itself?" —
 * are told apart by exactly that word, and a hover answers neither for a
 * keyboard or a touch.
 */
export const CompactionProgress = React.memo(function CompactionProgress({
  compaction,
  announce = true,
}: {
  compaction: LiveTranscriptCompaction;
  /** ChatPlane's persistent island region owns live turn announcements. */
  announce?: boolean;
}) {
  return (
    <div
      role={announce ? "status" : undefined}
      data-compaction-progress=""
      title={compaction.reason === "manual" ? "Manual compaction" : "Automatic compaction"}
      className="not-prose flex min-w-0 items-center gap-3 rounded-card border border-border bg-(--accent-tint) px-3 py-2 text-ui"
    >
      <Spinner aria-hidden role="presentation" className="size-4 shrink-0 text-primary-text" />
      <span className="font-medium text-foreground">Compacting context</span>
    </div>
  );
});

export const CompactionBoundary = React.memo(function CompactionBoundary({
  compaction,
}: {
  compaction: TranscriptCompaction;
}) {
  const copy = compactionBoundaryCopy(compaction);
  const compacted = compaction.outcome === "compacted";
  return (
    // The row hovers to its reason, and a failure's clipped detail in full.
    <div className="not-prose flex min-w-0 flex-col gap-1" title={copy.description}>
      <div className="flex min-w-0 items-center gap-2 text-ui">
        {compacted ? (
          <CollapseVerticalIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        ) : (
          // A failure that changed nothing is not a broken Session — the message
          // that paid for it was delivered on the context that was already
          // there. Attention, not destructive: something did not happen.
          <WarningIcon aria-hidden className="size-3.5 shrink-0 text-attention" />
        )}
        <span className="shrink-0 font-medium">{copy.headline}</span>
        {/* The rule runs from the label to the count, so the two ends of the
            row are the two things a glance wants and the line is what joins
            them. Only the compacted arm draws one; see the module note. */}
        {compacted ? <Separator aria-hidden className="min-w-4 flex-1" /> : null}
        {copy.before === null ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">{copy.before}</span>
        )}
      </div>
      {copy.detail === null ? null : (
        <p className="truncate text-ui text-muted-foreground">{copy.detail}</p>
      )}
    </div>
  );
});
