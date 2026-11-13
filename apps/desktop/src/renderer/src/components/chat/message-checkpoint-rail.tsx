/**
 * The checkpoint rail: one mark per message the person sent, beside the
 * transcript, and a card previewing that exchange (VC-1211).
 *
 * WHERE IT LIVES. In the empty margin left of the transcript column, and only
 * there: `message-checkpoint-rail.css` hides it with a container query on the
 * chat plane whenever that margin cannot hold it clear of the text. The width
 * that decides is the pane's own, so a split pane or a narrow window hides it
 * independently of the window.
 *
 * WHAT RE-RENDERS IT. Its props are held stable by the plane — the checkpoint
 * list keeps its identity through streamed tokens — and the current mark comes
 * from the {@link CheckpointNavigator} store, so the transcript's frames never
 * reach this component and a scroll reaches only it. Each mark is memoized, so
 * moving the current position or the card repaints the two marks involved.
 *
 * MOTION. None. Marks change instantly; the card is the shared hover card,
 * which has no entrance; a jump is an instant scroll. Reduced motion has
 * nothing to reduce.
 */
import * as React from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import type { CheckpointNavigator } from "./checkpoint-navigator";
import { MIN_CHECKPOINTS, type MessageCheckpoint } from "./message-checkpoints";
import "./message-checkpoint-rail.css";

/** A first card waits this long, so crossing the rail on the way elsewhere opens nothing. */
const OPEN_DELAY_MS = 150;
/** Long enough to cross the gap from a mark onto its card. */
const CLOSE_DELAY_MS = 100;
/** After a card closes, the next one opens at once: scrubbing is one gesture. */
const WARM_MS = 300;

export const MessageCheckpointRail = React.memo(function MessageCheckpointRail({
  checkpoints,
  navigator,
  readReply,
  belowHeader = false,
}: {
  checkpoints: readonly MessageCheckpoint[];
  navigator: CheckpointNavigator;
  /** The exchange's last agent text, read when a card opens rather than per token. */
  readReply(id: string): string | null;
  /** A header floats in the plane's top-left corner (a cloud Session's team row). */
  belowHeader?: boolean;
}) {
  const current = React.useSyncExternalStore(navigator.subscribe, navigator.current);
  const listRef = React.useRef<HTMLOListElement>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState<string | null>(null);

  // The card's own clock: Radix reports intent at once (both its delays are
  // zero) and this decides when a card actually opens or closes, so moving
  // from one mark to the next swaps the card instead of stacking two.
  const timer = React.useRef(0);
  const shown = React.useRef<string | null>(null);
  const closedAt = React.useRef(Number.NEGATIVE_INFINITY);
  React.useEffect(() => {
    shown.current = preview;
    if (preview === null) closedAt.current = performance.now();
  }, [preview]);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  // The mark just chosen. Its card stays shut until the pointer or focus
  // leaves it: Radix queues its own open on focus (a zero-delay timer), and a
  // press can land before that timer does.
  const chosen = React.useRef<string | null>(null);
  const setOpen = React.useCallback((id: string, open: boolean, now = false) => {
    if (chosen.current === id) {
      if (open) return;
      chosen.current = null;
    }
    window.clearTimeout(timer.current);
    if (open) {
      const warm = shown.current !== null || performance.now() - closedAt.current < WARM_MS;
      if (now || warm) setPreview(id);
      else timer.current = window.setTimeout(() => setPreview(id), OPEN_DELAY_MS);
      return;
    }
    timer.current = window.setTimeout(
      () => setPreview((previewed) => (previewed === id ? null : previewed)),
      CLOSE_DELAY_MS,
    );
  }, []);

  const close = React.useCallback(() => {
    window.clearTimeout(timer.current);
    setPreview(null);
  }, []);
  // The card has answered its question once the reader goes there; left open
  // it would sit over the message just landed on.
  const jump = React.useCallback(
    (id: string) => {
      chosen.current = id;
      close();
      navigator.jump(id);
    },
    [close, navigator],
  );
  // Focus is keyboard or a press: either way the card opens with it, without
  // the pointer's crossing delay, so the reply is there to be described.
  const focusMark = React.useCallback(
    (id: string) => {
      setFocused(id);
      // Focus arriving is focus that had left: a mark chosen earlier previews again.
      chosen.current = null;
      setOpen(id, true, true);
    },
    [setOpen],
  );

  // Keep the current mark inside a rail that scrolls (a long chat). Read only
  // when the current mark changes, never per frame.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || current === null || list.scrollHeight <= list.clientHeight) return;
    revealMark(list, markFor(list, current));
  }, [current, checkpoints]);

  // Cut edges fade; an edge flush with its first or last mark stays crisp.
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      // Hidden by the pane narrowing: its marks have no box left to anchor a
      // card to, so an open one closes rather than floating free.
      if (list.clientHeight === 0) {
        close();
        return;
      }
      const top = list.scrollTop > 1;
      const bottom = list.scrollHeight - list.scrollTop - list.clientHeight > 1;
      setEdges((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    list.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [checkpoints.length, close]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLOListElement>) => {
      const list = listRef.current;
      const from = (event.target as HTMLElement).closest<HTMLElement>("[data-checkpoint-mark]");
      if (list === null || from === null) return;
      const index = checkpoints.findIndex(
        (checkpoint) => checkpoint.id === from.dataset["checkpointMark"],
      );
      const next =
        event.key === "ArrowDown"
          ? index + 1
          : event.key === "ArrowUp"
            ? index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? checkpoints.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      const target = checkpoints[Math.max(0, Math.min(checkpoints.length - 1, next))];
      if (target === undefined) return;
      const mark = markFor(list, target.id);
      if (mark === null) return;
      // The rail scrolls itself; letting focus scroll would also move the
      // clipped transcript wrapper the rail is positioned against.
      mark.focus({ preventScroll: true });
      revealMark(list, mark);
    },
    [checkpoints],
  );

  if (checkpoints.length < MIN_CHECKPOINTS) return null;
  // One tab stop: the mark last focused, else the reader's current one.
  const stop =
    (focused !== null && checkpoints.some((checkpoint) => checkpoint.id === focused)
      ? focused
      : null) ??
    current ??
    checkpoints[checkpoints.length - 1]!.id;

  return (
    <nav
      aria-label="Messages"
      data-slot="message-checkpoints"
      data-below-header={belowHeader || undefined}
      className="message-checkpoints"
    >
      <ol
        ref={listRef}
        className="message-checkpoint-list"
        data-cut-top={edges.top || undefined}
        data-cut-bottom={edges.bottom || undefined}
        onKeyDown={onKeyDown}
      >
        {checkpoints.map((checkpoint) => (
          <CheckpointMark
            key={checkpoint.id}
            checkpoint={checkpoint}
            current={checkpoint.id === current}
            tabStop={checkpoint.id === stop}
            open={checkpoint.id === preview}
            onOpenChange={setOpen}
            onFocusMark={focusMark}
            onJump={jump}
            readReply={readReply}
          />
        ))}
      </ol>
    </nav>
  );
});

const CheckpointMark = React.memo(function CheckpointMark({
  checkpoint,
  current,
  tabStop,
  open,
  onOpenChange,
  onFocusMark,
  onJump,
  readReply,
}: {
  checkpoint: MessageCheckpoint;
  current: boolean;
  tabStop: boolean;
  open: boolean;
  onOpenChange(id: string, open: boolean): void;
  onFocusMark(id: string): void;
  onJump(id: string): void;
  readReply(id: string): string | null;
}) {
  const { id } = checkpoint;
  const replyId = React.useId();
  const reply = open ? readReply(id) : null;
  return (
    <li className="flex">
      <HoverCard
        open={open}
        openDelay={0}
        closeDelay={0}
        onOpenChange={(next) => onOpenChange(id, next)}
      >
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="message-checkpoint"
            data-checkpoint-mark={id}
            data-previewed={open || undefined}
            aria-current={current ? "location" : undefined}
            aria-label={checkpoint.label}
            aria-describedby={reply === null ? undefined : replyId}
            tabIndex={tabStop ? 0 : -1}
            onFocus={() => onFocusMark(id)}
            onClick={() => onJump(id)}
          >
            <span aria-hidden className="message-checkpoint-line" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="right"
          align="center"
          sideOffset={8}
          data-checkpoint-card=""
          className="flex w-80 flex-col gap-1 px-3 py-2"
        >
          {open ? (
            <CheckpointCard prompt={checkpoint.prompt} reply={reply} replyId={replyId} />
          ) : null}
        </HoverCardContent>
      </HoverCard>
    </li>
  );
});

function CheckpointCard({
  prompt,
  reply,
  replyId,
}: {
  prompt: string;
  reply: string | null;
  replyId: string;
}) {
  return (
    <>
      <p dir="auto" className="line-clamp-2 font-medium break-words text-foreground">
        {prompt}
      </p>
      {reply === null ? null : (
        <p id={replyId} dir="auto" className="line-clamp-3 break-words text-muted-foreground">
          {reply}
        </p>
      )}
    </>
  );
}

function markFor(list: HTMLElement, id: string): HTMLElement | null {
  for (const mark of list.querySelectorAll<HTMLElement>("[data-checkpoint-mark]"))
    if (mark.dataset["checkpointMark"] === id) return mark;
  return null;
}

/** Scroll the rail, and only the rail, until `mark` is inside it. */
function revealMark(list: HTMLElement, mark: HTMLElement | null): void {
  if (mark === null) return;
  const top = mark.offsetTop;
  const bottom = top + mark.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
