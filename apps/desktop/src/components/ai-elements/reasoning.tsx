"use client";

/**
 * Reasoning presentation — a status verb, not a collapsible.
 *
 * The model's own first `**bold**` line is the verb (OpenCode's TUI, Codex and
 * Cursor converged on this independently); the full text stays in the durable
 * transcript for the inspector rather than in the feed. There is no disclosure
 * here on purpose: a caret means process you can audit, and a one-line status
 * has nothing to audit.
 *
 * Wherever reasoning markdown *does* render (the audit body inside an expanded
 * activity group) it is neutered first — a footnote must never out-bold the
 * answer above it.
 */

import { cn } from "@renderer/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import * as React from "react";
import { Streamdown, type Components } from "streamdown";

import { chatMarkdownComponents } from "./chat-markdown";
import { Shimmer } from "./shimmer";

/**
 * How long a thought took, for streams that carry no timestamps of their own.
 *
 * It deliberately does not tick. The duration is only ever shown once the
 * thought has settled, so an interval would re-render the row several times a
 * second to animate a number that is not on screen. Codex, Zed, OpenCode and
 * t3code all refuse to run a live counter beside reasoning text that is still
 * growing; the pulsing dot is the liveness signal, and the number is the
 * receipt.
 */
export function useElapsed(streaming: boolean): number | null {
  const startedAt = React.useRef<number | null>(null);
  const [elapsed, setElapsed] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (streaming) {
      startedAt.current ??= Date.now();
      return;
    }
    if (startedAt.current === null) return;
    setElapsed(Date.now() - startedAt.current);
    startedAt.current = null;
  }, [streaming]);

  return elapsed;
}

export type ReasoningLineProps = {
  verb: string;
  meta: string | null;
  streaming: boolean;
  /** Sits against the verb, ahead of the meta — the disclosure caret's slot. */
  after?: React.ReactNode;
  className?: string;
};

export const ReasoningLine = React.memo(
  ({ verb, meta, streaming, after, className }: ReasoningLineProps) => (
    // `flex-1` matters: this row is sometimes a block child and sometimes a
    // flex item beside a caret. As a flex item it would otherwise shrink to its
    // content, which kills the `ml-auto` below and lets a growing verb shove the
    // elapsed time rightwards across the row. Codex pins the same affordance for
    // the same reason — the clock does not move because the label got longer.
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        <span
          className={cn("size-1.5 rounded-full bg-muted-foreground", streaming && "animate-pulse")}
        />
      </span>
      {streaming ? (
        <Shimmer as="span" className="min-w-0 truncate" duration={1.6}>
          {verb}
        </Shimmer>
      ) : (
        <span className="min-w-0 truncate">{verb}</span>
      )}
      {after}
      {meta ? <span className="ml-auto shrink-0 font-mono tabular-nums">{meta}</span> : null}
    </div>
  ),
);

ReasoningLine.displayName = "ReasoningLine";

/**
 * Reasoning markdown with its emphasis removed: bold reads as plain, headings
 * collapse to body weight, and blockquotes lose their rule. Reasoning is
 * commentary and must never compete with the answer typographically.
 */
export const reasoningMarkdownComponents: Components = {
  ...chatMarkdownComponents,
  strong: ({ className, children, ...props }) => (
    <span className={cn("font-normal", className)} {...props}>
      {children}
    </span>
  ),
  b: ({ className, children, ...props }) => (
    <span className={cn("font-normal", className)} {...props}>
      {children}
    </span>
  ),
  h1: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  h2: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  h3: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  h4: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  h5: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  h6: ({ className, children, ...props }) => (
    <p className={cn("font-normal", className)} {...props}>
      {children}
    </p>
  ),
  blockquote: ({ className, children, ...props }) => (
    <blockquote className={cn("my-1 border-0 pl-0 not-italic", className)} {...props}>
      {children}
    </blockquote>
  ),
};

const streamdownPlugins = { cjk, code, mermaid };
// Streamdown defers streaming paints via useTransition unless an animation
// plugin is present; without this the body stays blank until the transition
// commits — the blank-then-warp UX.
const immediateStreamingAnimation = { duration: 0, stagger: 0 } as const;

export type ReasoningBodyProps = {
  children: string;
  className?: string;
};

export const ReasoningBody = React.memo(({ children, className }: ReasoningBodyProps) => (
  <div className={cn("text-xs leading-5 text-muted-foreground", className)}>
    <Streamdown
      plugins={streamdownPlugins}
      animated={immediateStreamingAnimation}
      components={reasoningMarkdownComponents}
    >
      {children}
    </Streamdown>
  </div>
));

ReasoningBody.displayName = "ReasoningBody";
