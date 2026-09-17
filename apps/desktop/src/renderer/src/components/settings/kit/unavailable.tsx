/**
 * How a surface says "this is designed, and it does not work yet".
 *
 * NO CALLER TODAY, AND KEPT ON PURPOSE. MCP was the first preview drawn here
 * and VC-8 gave it its plumbing; Plugins was the last, and VC-378 removed the
 * category outright rather than keep previewing it. This file is not dead
 * weight to be swept: VC-379 brings back a Configure → Plugins pane against
 * the real Agent Plugins 1.0 package, which Volli will not support in full on
 * day one, and the component types it cannot run yet are exactly what an
 * honest preview is for. The rules below are the reason it is worth keeping
 * — they were learned, not designed, and rewriting them from scratch would
 * cost more than the fifty lines under this comment.
 *
 * WHEN TO REACH FOR IT. A surface has a shape worth showing and no plumbing
 * behind it. The alternative is hiding the category until the day it lands,
 * which is the right call whenever the shape itself is still in doubt — the
 * Plugins entry was hidden precisely because the pane it drew described a
 * plugin as "a bundle of skills and commands", and the published standard
 * covers skills and MCP servers. A preview of the wrong shape teaches the
 * wrong thing, and no banner above it repairs that.
 *
 * So: show the shape only when the shape is settled, and then ONLY under
 * three rules, because a preview that lies is worse than an absence:
 *
 *  1. **It says so, first and in words.** {@link UnavailableNotice} goes above
 *     the preview, not under it. Someone who reads one thing must read the one
 *     that stops them waiting for a response that is never coming.
 *  2. **Nothing in it can be operated.** Not "clicking does nothing" — a
 *     control that takes focus, depresses and then ignores you is the exact
 *     shape of a bug report. `inert` removes the whole subtree from hit
 *     testing, from the tab order, and from the accessibility tree at once.
 *  3. **It shows the empty state, never invented data.** A table of plausible
 *     fake servers is indistinguishable from real ones that have gone wrong,
 *     and someone will screenshot it. Whatever renders inside must be what a
 *     real, correctly-working, unconfigured surface would render.
 *
 * Rule 3 is not enforceable here; it is the caller's discipline, and every
 * pane that has ever used this passed an empty collection rather than a
 * fixture. The next one must too.
 */
import type * as React from "react";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";

import { Notice } from "@renderer/components/ui/notice";
import { cn } from "@renderer/lib/utils";

/**
 * The banner. One sentence on what is missing, one on what to do meanwhile.
 *
 * `tone="neutral"`, deliberately: this is not a fault, not a warning and not
 * something the reader can act on. An amber notice here would compete with the
 * real attention states on the same rail for a fact that is merely a roadmap.
 */
export function UnavailableNotice({
  what,
  meanwhile,
}: {
  /** What does not work yet, as a noun phrase: "MCP servers". */
  what: string;
  /** The honest alternative, if there is one. Omit when there is not. */
  meanwhile?: React.ReactNode;
}) {
  return (
    <Notice
      icon={WrenchIcon}
      tone="neutral"
      title={`${what} aren't available yet.`}
      detail={meanwhile ?? "This page previews the controls. You can't change them yet."}
    />
  );
}

/**
 * The preview itself: visible, dimmed, and genuinely inoperable.
 *
 * `inert` is doing the real work — it is one attribute that takes the subtree
 * out of hit testing, the tab order and the accessibility tree together. The
 * hand-rolled version of this is `pointer-events-none` plus `aria-hidden` plus
 * a `tabIndex={-1}` on every focusable descendant, and the third one is always
 * the one that gets forgotten, which leaves a keyboard user tabbing into a
 * region a mouse user cannot reach.
 *
 * The opacity is `/50` off the alpha ladder — half-present, which is what this
 * is. Not `/30`: at that weight the preview stops being legible, and an
 * illegible preview is just a smudge where a feature will be.
 */
export function UnavailablePreview({
  fill,
  children,
}: {
  /** Hand the leftover height to the preview, for one that is a table. */
  fill?: boolean;
  children: React.ReactNode;
}) {
  return (
    // eslint-disable-next-line react/no-unknown-property -- `inert` is a React 19 boolean prop.
    <div
      inert
      className={cn(
        "pointer-events-none opacity-50 select-none",
        fill && "flex min-h-0 flex-1 flex-col",
      )}
    >
      {children}
    </div>
  );
}

/** The two together, in the order that matters. */
export function Unavailable({
  what,
  meanwhile,
  fill,
  children,
}: {
  what: string;
  meanwhile?: React.ReactNode;
  /** Let the preview absorb the pane's leftover height. */
  fill?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <UnavailableNotice what={what} meanwhile={meanwhile} />
      <UnavailablePreview fill={fill}>{children}</UnavailablePreview>
    </>
  );
}
