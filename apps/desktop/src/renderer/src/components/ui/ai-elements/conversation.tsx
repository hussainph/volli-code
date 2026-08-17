"use client";

import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { wheelDetachesFollowing } from "./scroll-chaining";

/**
 * The render-prop form of `StickToBottom`'s children is deliberately dropped.
 * Nothing here needs the context at that level, and keeping it would mean a
 * branch in {@link StopFollowingBridge} that no call site ever takes.
 */
export type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "children"> & {
  children: ReactNode;
};

/**
 * NOTHING HERE ANIMATES A SCROLL. Both props are `instant`, for two unrelated
 * reasons that are worth keeping apart.
 *
 * `initial` governs exactly one moment — the first resize the library's observer
 * ever sees — and `initial="smooth"` spent it running a JS spring down the whole
 * scrollback: ~500ms of `scrollTop` written per frame, measured on a 1000-turn
 * transcript. Nobody asked to travel that distance. The reader did not scroll,
 * and there is no earlier position for the motion to relate the new one to; it
 * was a long animation of nothing, paid on the frame budget a session open has
 * the least of.
 *
 * Which moment that is depends on whether the transcript is already in hand when
 * this mounts. Mounted with messages, the first observation IS the transcript
 * and `initial` decides it; mounted on the empty state, the first observation is
 * the empty state's own height and everything after — the transcript included —
 * is a `resize`. Worth knowing before concluding this prop does nothing.
 *
 * `resize` IS INSTANT TOO, and that was a smooth spring until it was measured.
 *
 * The spring is a lag generator, not a smoother. Its defaults — stiffness 0.05,
 * damping 0.7, mass 1.25 — close about 9% of the remaining distance per frame,
 * so ~24 frames to close 90% of one gap. A streaming turn hands it a new gap
 * every third or fourth frame, which it never gets to finish, so it settles
 * into a standing offset and simply tows the column along underneath the
 * reader. Measured against `?resize=smooth` in `lab/scratches/chat-performance`
 * on the open-fence stream: the newest line sat a mean 89px — four and a half
 * lines — below the visible bottom edge for 95% of the stream's frames, and the
 * viewport was in motion on two frames out of every three. Instant: 13px, 35%,
 * and one frame in five. Smooth was still catching up 12px after the stream had
 * stopped; instant was already at rest.
 *
 * Which reads calmer is the same fact from the other side. Smooth means the
 * text is never once still, so there is no moment to lock a line onto; instant
 * moves in discrete steps and is motionless between them, the way a terminal
 * is. Neither smooths the case that actually jumps — a whole fenced block
 * landing in one commit measured ~295px against ~233px, content arriving faster
 * than a frame can answer — so the spring was not buying softness there either.
 *
 * Reduced motion needs no branch now: there is no motion left to reduce. The
 * prop stays open so the lab can put `smooth` back and re-run the comparison.
 */
export const Conversation = ({ className, resize, children, ...props }: ConversationProps) => {
  // Held by ref, not context, because this handler lives OUTSIDE the provider:
  // it listens on the wrapper the library itself renders. `contextRef` is the
  // library's own hand-out for exactly this position.
  const stickContext = useRef<StickToBottomContext | null>(null);

  // A wheel-up inside a nested scroller (an open bundle, a capped payload)
  // must detach auto-follow, and the library cannot see it — its wheel
  // handler bails on any target whose nearest scrollable ancestor is not the
  // transcript scroller. See scroll-chaining.ts for the full argument. React
  // registers `onWheel` passively, which is all this needs: it only observes
  // the gesture; the browser keeps scrolling whatever it was scrolling.
  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const context = stickContext.current;
    if (context === null) return;
    const detaches = wheelDetachesFollowing<Element>({
      deltaY: event.deltaY,
      target: event.target instanceof Element ? event.target : null,
      scroller: context.scrollRef.current,
      overflowYOf: (node) => getComputedStyle(node).overflowY,
    });
    if (detaches) context.stopScroll();
  }, []);

  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial="instant"
      resize={resize ?? "instant"}
      role="log"
      contextRef={stickContext}
      onWheel={handleWheel}
      {...props}
    >
      <StopFollowingBridge>{children}</StopFollowingBridge>
    </StickToBottom>
  );
};

/* --------------------------------------------------------------- following */

/**
 * Growth the agent produces is followed. Growth the reader reveals is not.
 *
 * `use-stick-to-bottom` has exactly one input — the content element got taller
 * — and one reaction to it: if the reader is at the bottom, scroll back to the
 * bottom. That is right for a streamed answer, whose new text *is* the bottom
 * edge, and wrong for every other way this column grows, because those grow it
 * ABOVE where the reader is looking. Opening a tool row while pinned unrolls
 * the payload at the caret — correct, and already what the browser does on its
 * own — and then the library slides the whole column up by that payload's
 * height to re-pin the bottom. The row you just clicked walks off the top of
 * the viewport and the transcript settles on the last message, which is the one
 * thing you were already looking at. That is the aggression.
 *
 * The library cannot tell the two cases apart; only the gesture knows. So the
 * gesture says so, and it says it in the library's own vocabulary: `stopScroll`
 * is the same detach the wheel performs on a scroll up. Opening a disclosure IS
 * an act of reading, and detaching is what reading means here — the reader gets
 * the "Scroll to latest" button they already know as the way back, rather than
 * a transcript that quietly disagrees with them about where they should be.
 *
 * The way back is free in the other direction too, and it is why this is a
 * detach rather than a suppression of one resize: collapsing the row shrinks
 * the content by exactly the height it added, the library's negative-resize
 * branch finds the bottom under the viewport again, and stickiness re-attaches
 * on its own. Expand detaches, collapse re-attaches, and neither needed a
 * second state of ours to say it.
 */
const StopFollowing = createContext<() => void>(() => {});

/**
 * What a disclosure calls before it grows the transcript under the reader.
 *
 * The default does nothing, and that is the point: rows render outside a
 * `Conversation` in unit tests and in lab scratches, where nothing is following
 * anything. `useStickToBottomContext()` throws there, which is not a fact a
 * presentation row should have to carry.
 */
export const useStopFollowing = (): (() => void) => useContext(StopFollowing);

/**
 * Published with a permanently stable identity, which is the whole reason this
 * is a ref and not the context value itself. `useStickToBottomContext()` hands
 * back a fresh object every time `isAtBottom` flips — constantly, mid-scroll —
 * and a context whose value changes re-renders every consumer through `memo`.
 * The consumers here are every tool row in the transcript.
 */
function StopFollowingBridge({ children }: { children: ReactNode }) {
  const { stopScroll } = useStickToBottomContext();
  const latest = useRef(stopScroll);
  useLayoutEffect(() => {
    latest.current = stopScroll;
  }, [stopScroll]);
  const stopFollowing = useMemo(() => () => latest.current(), []);
  return <StopFollowing.Provider value={stopFollowing}>{children}</StopFollowing.Provider>;
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-4 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        // Icon-only, so it needs a name of its own — there is no text to borrow.
        aria-label="Scroll to latest"
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon aria-hidden className="size-4" />
      </Button>
    )
  );
};
