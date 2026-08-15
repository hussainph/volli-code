"use client";

import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { Button } from "@renderer/components/ui/button";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/**
 * Opening a session STARTS at the bottom; only growth after that is animated.
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
 * `resize` stays smooth, and is a different question: by then the reader IS
 * somewhere, watching an answer push the bottom edge down, and the scroll is
 * what keeps them attached to it. Under reduced motion that becomes `instant`
 * — the library takes a `ScrollBehavior` here, so the opt-out is its own API
 * rather than something we have to defeat it with (use-stick-to-bottom 1.1.6
 * re-reads `resize` from a live ref, so flipping the OS setting mid-session
 * takes effect on the next growth without a remount).
 */
export const Conversation = ({ className, resize, ...props }: ConversationProps) => {
  const reducedMotion = useReducedMotion();
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial="instant"
      resize={resize ?? (reducedMotion ? "instant" : "smooth")}
      role="log"
      {...props}
    />
  );
};

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
