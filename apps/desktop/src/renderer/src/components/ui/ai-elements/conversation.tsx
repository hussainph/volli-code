"use client";

/**
 * Descended from AI Elements, and MODIFIED.
 *
 *   upstream  https://github.com/vercel/ai-elements
 *   file      packages/elements/src/conversation.tsx
 *   revision  9310a1d3a8ddc881244e7c48ec0f5d215df92e70 (2026-03-06)
 *   license   Apache-2.0 — Copyright 2023 Vercel, Inc.
 *
 * Far less of this file is upstream's than of `prompt-input.tsx`, but it is not
 * clean-room either: the component skeleton — `ConversationContent`,
 * `ConversationScrollButton`, `ConversationEmptyState`, their
 * `use-stick-to-bottom` wiring and their literal class strings — is copied
 * expression, which is why the notice is here. Changed: shared semantic icons,
 * `@renderer/*` imports, the scroll-chaining bridge below, both
 * `StickToBottom` props forced to `instant` where upstream animates, and
 * `ConversationEmptyState` reduced to its shell (no default title or copy),
 * and `ConversationContent`'s masked viewport, reachable through `viewportRef`,
 * which `ConversationScrollButton` marks while it is up, and following decided
 * from the reader's own scrolls (`useReaderFollowing`).
 *
 * Apache-2.0 §4(b) requires a modified file to say so. See `./PROVENANCE.md`.
 */

import { ArrowDownIcon } from "@renderer/components/ui/icon";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { prefersReducedMotion } from "@renderer/hooks/use-reduced-motion";
import type { ComponentProps, MouseEvent, ReactNode, Ref } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { SCROLL_THUMB_GRAB_EVENT } from "@renderer/lib/scroll-thumb/overlay-scrollbars";

import { followingAfterScroll, keyScrollsUp, scrollPlace } from "./reader-following";
import { wheelDetachesFollowing } from "./scroll-chaining";
import { glideToLatest } from "./scroll-to-latest";

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
 *
 * The one scroll that does move is the one a person asks for: "Scroll to
 * latest" ({@link ConversationScrollButton}), and its motion is not the
 * library's either.
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
      <ConversationBridge>{children}</ConversationBridge>
    </StickToBottom>
  );
};

/* --------------------------------------------------------------- following */

/*
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
/**
 * The transcript's scroller, and the detach above, behind ONE stable object.
 *
 * Both answers come from `useStickToBottomContext()`, and neither may be read
 * from it directly by a consumer in the transcript — see
 * {@link ConversationBridge} for why. The scroller is published as a getter
 * rather than the element because the element arrives a commit after the first
 * render and a value would have been `null` forever.
 */
export interface ConversationControl {
  /** Detach auto-follow before growing the column under the reader. */
  stopFollowing(): void;
  /** The scrolling element, or `null` outside a `Conversation`. */
  scroller(): HTMLElement | null;
}

const NO_CONVERSATION: ConversationControl = {
  stopFollowing: () => {},
  scroller: () => null,
};

const ConversationControlContext = createContext<ConversationControl>(NO_CONVERSATION);

/**
 * What a disclosure calls before it grows the transcript under the reader.
 *
 * The default does nothing, and that is the point: rows render outside a
 * `Conversation` in unit tests and in lab scratches, where nothing is following
 * anything. `useStickToBottomContext()` throws there, which is not a fact a
 * presentation row should have to carry.
 */
export const useStopFollowing = (): (() => void) =>
  useContext(ConversationControlContext).stopFollowing;

/**
 * The same hand-out for a consumer that also has to READ the scroll position —
 * the windowed transcript (VC-338), which keeps the reader's place when it
 * mounts a page of earlier rows above them. Outside a `Conversation` it answers
 * `null` for the scroller, so a row list in a test or a lab scratch simply does
 * no compensating.
 */
export const useConversationControl = (): ConversationControl =>
  useContext(ConversationControlContext);

/**
 * Published with a permanently stable identity, which is the whole reason this
 * is a ref and not the context value itself. `useStickToBottomContext()` hands
 * back a fresh object every time `isAtBottom` flips — constantly, mid-scroll —
 * and a context whose value changes re-renders every consumer through `memo`.
 * The consumers here are every tool row in the transcript.
 */
function ConversationBridge({ children }: { children: ReactNode }) {
  useReaderFollowing();
  const { stopScroll, scrollRef } = useStickToBottomContext();
  const latest = useRef({ stopScroll, scrollRef });
  useLayoutEffect(() => {
    latest.current = { stopScroll, scrollRef };
    const scroller = scrollRef.current;
    if (scroller) scroller.dataset.conversationScroller = "";
  }, [scrollRef, stopScroll]);
  const control = useMemo<ConversationControl>(
    () => ({
      stopFollowing: () => latest.current.stopScroll(),
      scroller: () => latest.current.scrollRef.current,
    }),
    [],
  );
  return (
    <ConversationControlContext.Provider value={control}>
      {children}
    </ConversationControlContext.Provider>
  );
}

/**
 * How long a scrolling key press, or a press lifted off the scrollbar, still
 * counts as the reader's hand on the transcript, in milliseconds. That covers
 * one smooth keyboard scroll (about 150ms in Chromium) with room to spare, and
 * a held key's repeats keep renewing it.
 */
const READER_HAND_MS = 500;

/** Where a key press types rather than scrolls. */
const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Where Space presses a control rather than scrolling. */
const SPACE_CONTROL = "button, a[href], summary, [role='button'], [role='link']";
/** The end of a press or touch on the transcript, wherever it lifts. */
const LIFT_EVENTS = ["pointerup", "pointercancel", "touchend", "touchcancel"] as const;

/**
 * Following, decided by the reader's own scrolls; the rule and the reason the
 * library's version of it does not hold up are in `reader-following.ts`.
 *
 * A scroll event releases at once when it moves away from the end under the
 * reader's hand. Releasing synchronously matters: the library's
 * following loop writes on the frame's animation callbacks, which run after
 * this event, and once released it stops instead of pulling the reader back
 * mid-scroll.
 *
 * An arrival is applied one millisecond later instead. The library judges the
 * same event on a one-millisecond timer of its own, which can still read
 * anchoring as a scroll up and release (VC-1232). Timers with equal delays
 * run in the order they were set. The library's listener was attached when
 * its scroller mounted, before this effect ran, so this one runs after it and
 * has the last word.
 *
 * Engaging uses the library's own `scrollToBottom("instant")`, as "Scroll to
 * latest" does on arrival. It is only called when the library has not already
 * re-attached by itself, so the move it makes is the one following was about
 * to make anyway.
 */
function useReaderFollowing() {
  const { scrollRef, state, scrollToBottom, stopScroll } = useStickToBottomContext();
  const latest = useRef({ scrollToBottom, stopScroll });
  useLayoutEffect(() => {
    latest.current = { scrollToBottom, stopScroll };
  }, [scrollToBottom, stopScroll]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const view = scroller.ownerDocument.defaultView ?? window;
    let place = scrollPlace(scroller);
    let held = false;
    let handUntil = 0;
    const timers = new Set<number>();
    const onScroll = () => {
      const previous = place;
      place = scrollPlace(scroller);
      const readerHand = held || performance.now() < handUntil;
      const change = followingAfterScroll(previous, place, readerHand);
      if (change === "release") {
        if (state.isAtBottom) latest.current.stopScroll();
      } else if (change === "follow") {
        const timer = view.setTimeout(() => {
          timers.delete(timer);
          if (!state.isAtBottom) void latest.current.scrollToBottom("instant");
        }, 1);
        timers.add(timer);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof view.Element ? event.target : null;
      const up = keyScrollsUp({
        key: event.key,
        shiftKey: event.shiftKey,
        inTextEntry: target?.closest(TEXT_ENTRY) != null,
        onControl: target?.closest(SPACE_CONTROL) != null,
      });
      if (up) handUntil = performance.now() + READER_HAND_MS;
    };
    // A press on the scroller itself, not on anything inside it, is a press on
    // its scrollbar. A touch anywhere in it is a hand on it.
    const onPress = (event: PointerEvent) => {
      if (event.target === scroller) held = true;
    };
    const onTouch = () => {
      held = true;
    };
    const onLift = () => {
      if (!held) return;
      held = false;
      handUntil = performance.now() + READER_HAND_MS;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("pointerdown", onPress, { passive: true });
    scroller.addEventListener("touchstart", onTouch, { passive: true });
    view.addEventListener("keydown", onKey);
    for (const name of LIFT_EVENTS) view.addEventListener(name, onLift, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("pointerdown", onPress);
      scroller.removeEventListener("touchstart", onTouch);
      view.removeEventListener("keydown", onKey);
      for (const name of LIFT_EVENTS) view.removeEventListener(name, onLift);
      for (const timer of timers) view.clearTimeout(timer);
    };
  }, [scrollRef, state]);
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content> & {
  /** The masked, non-scrolling viewport around the content. */
  viewportRef?: Ref<HTMLDivElement>;
};

export const ConversationContent = ({
  className,
  viewportRef,
  ...props
}: ConversationContentProps) => (
  <div
    ref={viewportRef}
    data-conversation-viewport=""
    className="h-full overflow-hidden [contain:layout_paint] isolate"
  >
    <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />
  </div>
);

export type ConversationEmptyStateProps = ComponentProps<"div">;

/** A caller-drawn empty state in upstream's centring shell; it carries no copy of its own. */
export const ConversationEmptyState = ({
  className,
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
    {children}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

/**
 * The reader's own hand on the transcript during a trip to the end: it is
 * theirs again at once. A wheel, a press, a touch, or a grab of the scroll
 * thumb — whose press is swallowed before it reaches the scroller, so the thumb
 * says so itself (`lib/scroll-thumb`).
 */
const TAKE_BACK_EVENTS = ["wheel", "pointerdown", "touchstart", SCROLL_THUMB_GRAB_EVENT] as const;

/**
 * "Scroll to latest". The trip is `glideToLatest`'s, not the library's spring,
 * which stopped short whenever content above the reader changed height on the
 * way (VC-1232; the argument is in `scroll-to-latest.ts`). The library is told
 * on arrival, with an instant `scrollToBottom`, so following a streamed reply
 * starts from the end. The trip outlives the button's own hiding: this
 * component stays mounted while the transcript has messages and only its
 * button comes and goes.
 */
export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom, scrollRef, contentRef } = useStickToBottomContext();
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [travelling, setTravelling] = useState(false);
  const stopTrip = useRef<(() => void) | null>(null);
  useEffect(() => () => stopTrip.current?.(), []);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setAwayFromBottom(
        scroller.clientHeight > 0 &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, contentRef, isAtBottom]);

  // Gone the moment it is pressed, as it was when the library's spring
  // claimed the bottom on the press.
  const shown = !isAtBottom && awayFromBottom && !travelling;
  // While the button is up, the masked viewport lifts its bottom fade above it
  // (`[data-scroll-button]` in globals.css). Marked here rather than read back
  // with `.chat-transcript:has(<this button>)`: a `:has()` whose argument
  // reaches every descendant of the transcript makes each row, page or tool
  // card inserted anywhere in it restyle thousands of elements (VC-1231).
  useLayoutEffect(() => {
    if (!shown) return;
    const viewport = scrollRef.current?.closest<HTMLElement>("[data-conversation-viewport]");
    if (!viewport) return;
    viewport.dataset.scrollButton = "";
    return () => {
      delete viewport.dataset.scrollButton;
    };
  }, [shown, scrollRef]);

  const handleScrollToBottom = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const scroller = scrollRef.current;
      if (scroller === null) return;
      stopTrip.current?.();
      const end = () => {
        for (const name of TAKE_BACK_EVENTS) scroller.removeEventListener(name, takeBack);
        stopTrip.current = null;
        setTravelling(false);
      };
      // Keyboard activation (a click with no pointer behind it) and reduced
      // motion arrive at once; a pointer press glides.
      const cancel = glideToLatest(scroller, event.detail === 0 || prefersReducedMotion(), () => {
        end();
        scrollToBottom("instant");
      });
      function takeBack() {
        cancel();
        end();
      }
      for (const name of TAKE_BACK_EVENTS) {
        scroller.addEventListener(name, takeBack, { passive: true });
      }
      stopTrip.current = takeBack;
      setTravelling(true);
    },
    [scrollRef, scrollToBottom],
  );

  return (
    shown && (
      <Button
        // Icon-only, so it needs a name of its own — there is no text to borrow.
        aria-label="Scroll to latest"
        data-slot="conversation-scroll-button"
        className={cn(
          "absolute z-10 bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
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
