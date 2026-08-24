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
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

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
}: {
  compaction: LiveTranscriptCompaction;
}) {
  return (
    <div
      role="status"
      className="not-prose flex min-w-0 items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-ui"
    >
      <Spinner aria-hidden role="presentation" className="size-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="font-medium text-foreground">
          {compaction.reason === "manual"
            ? "Compacting context…"
            : "Compacting context on its own…"}
        </p>
        <p className="text-muted-foreground">Preparing a shorter working context</p>
      </div>
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
    // The whole row hovers to its full sentence: both the reason and the note
    // clip on a narrow window, and this is the only way back to the rest of one.
    <div className="not-prose flex min-w-0 flex-col gap-1" title={copy.description}>
      <div className="flex min-w-0 items-center gap-2 text-ui">
        {compacted ? (
          <ArrowsInLineVerticalIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        ) : (
          // A failure that changed nothing is not a broken Session — the message
          // that paid for it was delivered on the context that was already
          // there. Attention, not destructive: something did not happen.
          <WarningIcon aria-hidden className="size-3.5 shrink-0 text-attention" weight="fill" />
        )}
        <span className="shrink-0 font-medium">{copy.headline}</span>
        <span className="min-w-0 truncate text-muted-foreground">{copy.reason}</span>
        {/* The rule runs from the label to the count, so the two ends of the
            row are the two things a glance wants and the line is what joins
            them. Only the compacted arm draws one; see the module note. */}
        {compacted ? <Separator aria-hidden className="min-w-4 flex-1" /> : null}
        {copy.before === null ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">{copy.before}</span>
        )}
      </div>
      {/* The row's actual job, said once: what a reader scrolling up is looking
          at. Everything above this line is still here and still true; it is
          simply not what the model is reading any more. */}
      <p className="text-ui text-muted-foreground/70">{copy.note}</p>
      {copy.detail === null ? null : (
        <p className="truncate text-ui text-muted-foreground/70">{copy.detail}</p>
      )}
    </div>
  );
});
