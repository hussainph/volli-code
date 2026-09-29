/**
 * The Browser replay (VC-453): a Session's Browser Traces, stepped through
 * frame by frame. Opened from a browse row's card in the transcript and from
 * the Activity Island's tabs card; the two differ only in where it starts.
 *
 * A modal over the chat, like the subagent peek and the shell tail: a look
 * back, then back to the chat. A Radix dialog is also what makes it safe over
 * a live Browser plane — the freeze rule (`browser-plane-freeze.ts`) stands
 * every native view down while a dialog is open.
 *
 * WHAT IT DRAWS. The record is `@volli/shared`'s: the steps in the order the
 * calls settled, across every tab the Session owned, each with the frame the
 * host took after it. Page text in it — a title, an element's name — was
 * cleaned by the host on the way in and is drawn here as plain text, the way
 * the transcript card draws the same two facts. Frames come by picture id
 * through the card's own cache and bridge, so a frame the card already showed
 * is not asked for twice.
 *
 * MOVING. Arrow keys step, PageUp/PageDown stride, Home/End jump — heard on
 * the window while the replay is open, since it is modal; the scrub
 * track is a slider a pointer can drag; Previous and Next buttons sit either
 * side of it. Which step each lands on is `browser-trace-model.ts`'s rule.
 *
 * LIVE. While open, the trace is re-read on a short interval, so a replay
 * opened mid-run grows with the Session; a person watching the newest step
 * is carried along, and one who scrubbed back is left where they are.
 *
 * MOUNTED ONLY WHILE OPEN, like its siblings, so a closed replay polls
 * nothing and holds no frames.
 */
import * as React from "react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";

import {
  type BrowserTrace,
  type BrowserTraceFrame,
  browserTraceStartIndex,
  browserTraceTimeline,
  errorMessage,
} from "@volli/shared";

import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { BrowserTabMark } from "@renderer/components/browser/browser-tab-mark";
import {
  displayUrl,
  prefetchBrowserPicture,
  useBrowserPicture,
} from "@renderer/components/browser/browser-tab-card";
import {
  type BrowserTraceRequest,
  browserTraceFacts,
  clampTraceIndex,
  followTraceIndex,
  traceIndexAtOffset,
  traceIndexForKey,
} from "@renderer/components/browser/browser-trace-model";
import { Button } from "@renderer/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** How often an open replay re-reads the trace. */
export const BROWSER_TRACE_REFRESH_MS = 2_000;

export interface BrowserTraceDialogProps {
  /** Which Session's replay, and where it starts; `null` for closed. */
  request: BrowserTraceRequest | null;
  api: BrowserApi;
  onClose(): void;
  /** Test seam; production re-reads every {@link BROWSER_TRACE_REFRESH_MS}. */
  refreshMs?: number;
}

export function BrowserTraceDialog({
  request,
  api,
  onClose,
  refreshMs = BROWSER_TRACE_REFRESH_MS,
}: BrowserTraceDialogProps) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-browser-trace-dialog=""
        aria-describedby={undefined}
        className="flex h-[80vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        {request === null ? null : (
          <TraceReplay
            key={`${request.sessionId}:${request.tabId ?? ""}:${request.pictureId ?? ""}`}
            request={request}
            api={api}
            refreshMs={refreshMs}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const NO_FRAMES: readonly BrowserTraceFrame[] = [];

type ReplayState =
  | { kind: "loading" }
  | { kind: "ready"; timeline: BrowserTraceFrame[]; dropped: number };

/** What changed between two reads, cheaply: ids, bounds and counts. */
function signatureOf(traces: readonly BrowserTrace[]): string {
  return traces
    .map((trace) => `${trace.traceId}:${trace.droppedSteps}:${trace.steps.length}`)
    .join("|");
}

function TraceReplay({
  request,
  api,
  refreshMs,
}: {
  request: BrowserTraceRequest;
  api: BrowserApi;
  refreshMs: number;
}) {
  const [state, setState] = React.useState<ReplayState>({ kind: "loading" });
  const [index, setIndex] = React.useState(0);
  const shown = React.useRef<readonly BrowserTraceFrame[]>(NO_FRAMES);
  const signature = React.useRef<string | null>(null);

  React.useEffect(() => {
    let live = true;
    const read = async (first: boolean): Promise<void> => {
      try {
        const result = await api.traces({ sessionId: request.sessionId });
        if (!result.ok) throw new Error(result.error);
        if (!live) return;
        const next = signatureOf(result.traces);
        if (!first && next === signature.current) return;
        signature.current = next;
        const timeline = browserTraceTimeline(result.traces);
        const before = shown.current;
        shown.current = timeline;
        setState({
          kind: "ready",
          timeline,
          dropped: result.traces.reduce((sum, trace) => sum + trace.droppedSteps, 0),
        });
        setIndex((current) =>
          first
            ? browserTraceStartIndex(timeline, request)
            : followTraceIndex(current, before, timeline),
        );
      } catch (reason) {
        if (!live) return;
        // The first read is one the person is waiting on; a refresh that
        // fails keeps the replay they already have and tries again.
        if (first) {
          toastError(`Could not load the Browser replay: ${errorMessage(reason)}`);
          setState({ kind: "ready", timeline: [], dropped: 0 });
        } else {
          console.warn("[volli] Browser replay refresh failed:", reason);
        }
      }
    };
    void read(true);
    const timer = setInterval(() => void read(false), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, refreshMs, request]);

  const timeline = state.kind === "ready" ? state.timeline : NO_FRAMES;
  const at = clampTraceIndex(index, timeline.length);
  const current = timeline[at] ?? null;
  const facts = browserTraceFacts(timeline, at);

  // Warm the neighbours, so a step either way lands on a frame in hand.
  React.useEffect(() => {
    for (const near of [timeline[at - 1], timeline[at + 1]]) {
      const pictureId = near?.step.pictureId ?? null;
      if (pictureId !== null) prefetchBrowserPicture(api, pictureId);
    }
  }, [api, at, timeline]);

  // The window's keys, not the focused element's: the replay is modal, so
  // every key is its own, and focus can land anywhere in it — or, opened from
  // the island's popover, be handed back to the island's anchor as the popover
  // closes. A key-per-element handler would go deaf in exactly that case.
  const count = timeline.length;
  const currentIndex = React.useRef(at);
  currentIndex.current = at;
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const next = traceIndexForKey(event.key, currentIndex.current, count);
      if (next === null) return;
      event.preventDefault();
      setIndex(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tall enough that the content's close button (top-4 right-4) lands in it. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-12 pl-4">
        <DialogTitle className="min-w-0 truncate text-ui font-medium">Browser replay</DialogTitle>
        {timeline.length > 0 ? (
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums" data-trace-position>
            Step {at + 1} of {timeline.length}
            {state.kind === "ready" && state.dropped > 0 ? " · earlier steps not kept" : null}
          </span>
        ) : null}
      </div>
      {state.kind === "loading" ? (
        <div className="m-4 flex-1 animate-pulse rounded-md bg-muted/50" aria-hidden />
      ) : current === null || facts === null ? (
        <div
          className="flex flex-1 items-center justify-center text-ui text-muted-foreground"
          data-trace-empty
        >
          Nothing recorded for this Session
        </div>
      ) : (
        <>
          <Frame api={api} pictureId={current.step.pictureId} />
          <div
            className="flex shrink-0 flex-col gap-1 border-t border-border px-4 py-2 text-ui"
            data-trace-step={current.step.seq}
            data-trace-outcome={current.step.outcome}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-foreground" data-trace-caption>
                {facts.verb}
                {facts.object === null ? null : ` ${facts.object}`}
              </span>
              {facts.trouble === null ? null : (
                <span
                  className="flex min-w-0 items-center gap-1 text-destructive"
                  title={facts.trouble}
                  data-trace-trouble
                >
                  <WarningCircleIcon aria-hidden weight="fill" className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{facts.trouble}</span>
                </span>
              )}
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                <time dateTime={new Date(current.step.at).toISOString()}>{facts.time}</time>
                {` · ${facts.offset}`}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <BrowserTabMark driven />
              {facts.tab === null ? null : <span className="shrink-0">{facts.tab}</span>}
              {facts.title === null ? null : (
                <span className="min-w-0 shrink truncate text-foreground">{facts.title}</span>
              )}
              {facts.url === null ? null : (
                <span className="min-w-0 flex-1 truncate font-mono" title={facts.url}>
                  {displayUrl(facts.url)}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Previous step"
              disabled={at === 0}
              onClick={() => setIndex(at - 1)}
            >
              <CaretLeftIcon weight="bold" />
            </Button>
            <ScrubTrack timeline={timeline} index={at} onScrub={setIndex} label={facts.verb} />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Next step"
              disabled={at >= timeline.length - 1}
              onClick={() => setIndex(at + 1)}
            >
              <CaretRightIcon weight="bold" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The frame the host took after the step. While the next one loads the last
 * frame stays up, dimmed, so stepping quickly reads as motion, not flicker.
 */
function Frame({ api, pictureId }: { api: BrowserApi; pictureId: string | null }) {
  const picture = useBrowserPicture(api, pictureId);
  const [shown, setShown] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (picture.kind === "ready") setShown(picture.dataUrl);
    if (picture.kind === "gone") setShown(null);
  }, [picture]);
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-3">
      {pictureId === null ? (
        <span className="text-ui text-muted-foreground">No picture for this step</span>
      ) : picture.kind === "gone" ? (
        <span className="text-ui text-muted-foreground">Picture unavailable</span>
      ) : shown === null ? (
        <div className="size-full animate-pulse rounded-sm bg-muted/50" aria-hidden />
      ) : (
        <img
          alt="The page after this step"
          src={shown}
          draggable={false}
          data-trace-frame={pictureId}
          className={cn(
            "max-h-full max-w-full rounded-sm border border-border/50 object-contain",
            picture.kind === "loading" && "opacity-60",
          )}
        />
      )}
    </div>
  );
}

/**
 * One segment per step, the current one raised in the primary tone and the
 * refused, failed or did-not-load ones in the destructive tone, so a person can see where
 * things went wrong before scrubbing to them. A slider to assistive
 * technology; the keys are the replay's own, handled above.
 */
function ScrubTrack({
  timeline,
  index,
  onScrub,
  label,
}: {
  timeline: readonly BrowserTraceFrame[];
  index: number;
  onScrub(index: number): void;
  label: string;
}) {
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onScrub(traceIndexAtOffset(event.clientX - box.left, box.width, timeline.length));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Step"
      aria-valuemin={1}
      aria-valuemax={timeline.length}
      aria-valuenow={index + 1}
      aria-valuetext={`Step ${index + 1} of ${timeline.length}: ${label}`}
      data-trace-scrub=""
      className={cn(
        "flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        timeline.length <= 120 && "gap-px",
      )}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        scrub(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event);
      }}
    >
      {timeline.map((frame, position) => (
        <span
          key={`${frame.traceId}:${frame.step.seq}`}
          className={cn(
            "min-w-0 flex-1 rounded-xs transition-[height] duration-100 motion-reduce:transition-none",
            position === index
              ? "h-4 bg-primary"
              : frame.step.outcome === "ok" && frame.step.error === null
                ? "h-2 bg-muted-foreground/35"
                : "h-2 bg-destructive/70",
          )}
        />
      ))}
    </div>
  );
}
