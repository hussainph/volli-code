"use client";

import { cn } from "@renderer/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";

import { chatMarkdownComponents } from "./chat-markdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-4 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// `plugins` is not a prop here: the fixed set below is the decision to ship
// code and Mermaid without math, and a caller-supplied map would override it.
export type MessageResponseProps = Omit<ComponentProps<typeof Streamdown>, "plugins">;

const streamdownPlugins = { cjk, code, mermaid };

/**
 * `animated` is not passed, and its absence is the load-bearing part.
 *
 * Streamdown 2.5.0 reads the prop exactly twice, and both readings key off
 * whether it built an animation controller from it — `ge` in the compiled
 * chunk (`dist/chunk-BO2N2NFS.js`):
 *
 *     Ue = useMemo(() => u === true ? "true" : u ? JSON.stringify(u) : "", [u])
 *     ge = useMemo(() => Ue ? (Ue === "true" ? be() : be(u)) : null, [Ue])
 *     useEffect(() => { t === "streaming" && !ge ? U(() => { Tt(fe) }) : Tt(fe) }, [fe, t])
 *     ...  ge && m && (k = [...k, ge.rehypePlugin])
 *
 * where `u` is `animated`, `U` is `startTransition`, `Tt` sets the rendered
 * block list and `m` is `isAnimating`. So a truthy `animated` — ANY truthy
 * value, `{duration: 0, stagger: 0}` included — builds a controller, and a
 * controller takes the else branch: every streamed token re-renders the whole
 * block tree at urgent priority, inside the same task, ahead of paint. The
 * transition branch is reachable only with no controller at all.
 *
 * `{duration: 0, stagger: 0}` was written to kill the typewriter delay and it
 * did, but it bought the blocking scheduler with it, and a second cost nobody
 * asked for: the animate plugin splits every text node into one `<span
 * data-sd-animate>` per WORD (measured at 152 of them on a 4KB answer), rebuilt
 * on every token, to run a 0ms animation.
 *
 * Omitting the prop and passing `animated={false}` are the same instruction —
 * `Ue` is `""` for both, so `ge` is `null` for both, so neither the scheduler
 * nor the plugin can tell them apart. Omission is the one written down: `false`
 * reads as an animation configured off, which is an invitation to turn it back
 * on, and what we want is for there to be no animation to configure. A caller
 * that genuinely wants one can still pass it — it rides `...props`.
 */
export const MessageResponse = memo(
  ({ className, components, ...props }: MessageResponseProps) => {
    // The `components` map must keep one identity for as long as its members do.
    // Streamdown re-derives its internal map whenever this object's identity
    // changes, and because we define `inlineCode` it re-wraps `code` in a fresh
    // closure each time. `code` is an element TYPE, so a new function there is a
    // new type at the same position: React tears down every fenced block in the
    // message and mounts a replacement, which restarts each block at its
    // unhighlighted fallback before Shiki's cache puts the tokens back. On a
    // streaming answer that is every closed fence re-highlighting per chunk —
    // measured at 33k DOM mutations for a 4KB message (docs/plans/delta-frames.md).
    // A literal spread here recreated the object on every token.
    const merged = useMemo(
      () => (components ? { ...chatMarkdownComponents, ...components } : chatMarkdownComponents),
      [components],
    );
    return (
      <Streamdown
        {...props}
        className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
        plugins={streamdownPlugins}
        components={merged}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
