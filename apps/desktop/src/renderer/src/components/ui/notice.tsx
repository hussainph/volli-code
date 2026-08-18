/**
 * The inline notice: a bounded block that reports one thing the surface under
 * it cannot, and offers at most a couple of ways out.
 *
 * Eight surfaces drew this by hand — a stalled watch in the rail, a failed
 * worktree ensure, a reconciliation conflict, a sign-in failure, a truncated
 * file, a paused autosave, a clean branch — in four fills, three radii and two
 * border alphas. None of that was a decision: the alphas were `/30` and `/25`
 * on the same edge, and the radii were `rounded-md` and `rounded-lg` on blocks
 * that sit two panes apart and are never seen together. `ticket/rail-panel-parts.tsx`'s
 * fault banner is the refined one and this is its drawing, generalised.
 *
 * THREE TONES, NOT FOUR. `error` tints the whole block, because a fault has to
 * be legible before it is read. Everything else leaves the block quiet and lets
 * the mark carry the meaning — which is what `positive` is: a neutral surface
 * with a green check, exactly as the Diffs page's "No changes from base" card
 * already drew it. The audit proposed a fourth, `waiting`, and no site in the
 * app has ever drawn one differently from `neutral`: the chat plane's waiting
 * blocker is a muted block with a clock in it, and the clock is the caller's
 * `icon`. A tone whose drawing is identical to another tone's is not a tone; it
 * is a name that invites the next author to invent a colour for it.
 *
 * THE ANNOUNCEMENT GOES ON THE MESSAGE, NEVER ON ANYTHING THAT HOLDS A CONTROL.
 * `editor/live-reconciliation-affordance.tsx` worked this out first: a live
 * region containing buttons gets the buttons re-announced on every polite
 * update, and some screen readers flatten the region's content into text rather
 * than surfacing the controls as controls. So `announce` marks the paragraphs
 * and nothing else — which is why the message is its own block inside the text
 * column rather than the column itself. `layout="stack"` puts its actions in
 * that column too, under the text, and a live region on the column would have
 * swallowed them exactly as the rail's `role="alert"` banner once swallowed
 * Retry. The stacked actions are the announced block's SIBLING.
 *
 * ACTIONS ARE `Button`s. The slot exists so the notice never draws one itself:
 * the fault banner's Retry was a bare `<button>` with `hover:underline` and no
 * focus ring at all, which is what happens when a component that is not a
 * control primitive starts drawing controls.
 */
import type * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { cn } from "@renderer/lib/utils";

export type NoticeTone = "neutral" | "error" | "positive";

/**
 * Surface and ink. Only `error` claims the block; the other two are the same
 * quiet card and differ in nothing but the mark the caller hands them, which is
 * why {@link NOTICE_MARK} is a separate table rather than a fourth column here.
 */
const NOTICE_TONE: Record<NoticeTone, string> = {
  neutral: "border-border bg-muted/30 text-muted-foreground",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  positive: "border-border bg-muted/30 text-muted-foreground",
};

/**
 * The mark's ink and weight.
 *
 * `fill` on exactly the two tones that are exceptions on their own surface (the
 * fault's warning, the clean branch's check — both recorded in the audit's icon
 * pass as legitimate fills), and outline on `neutral`, where the block says
 * nothing loud enough to need a heavier drawing. `error` inherits the block's
 * ink; `positive` is the only place a mark is coloured against a quiet card,
 * because being green is the entire message.
 */
const NOTICE_MARK: Record<NoticeTone, { className: string; fill: boolean }> = {
  neutral: { className: "", fill: false },
  error: { className: "", fill: true },
  positive: { className: "text-positive", fill: true },
};

export function Notice({
  tone = "neutral",
  icon: Icon,
  title,
  detail,
  actions,
  layout = "row",
  truncate = false,
  announce = false,
  hoverTitle,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  tone?: NoticeTone;
  icon?: PhosphorIcon;
  title: React.ReactNode;
  /** The second line: the same sentence's specifics, a step quieter. */
  detail?: React.ReactNode;
  /** `Button`s. Inline at the end of the row, or under the text when stacked. */
  actions?: React.ReactNode;
  /**
   * Where the actions sit — and, following from that, how the mark aligns.
   * `row` parks them at the end of the line and centres the mark on the text;
   * `stack` puts them under it and hangs the mark from the first line.
   */
  layout?: "row" | "stack";
  /**
   * For a notice in a column the user can drag narrow: hold it to one line and
   * put the full text on hover. Off by default — a notice that is allowed to
   * wrap should wrap, and clipping a sentence to save four pixels is how the
   * rail once reported a fault nobody could read.
   */
  truncate?: boolean;
  /** Announce the message politely. The actions stay outside the live region. */
  announce?: boolean;
  /** The untruncated text, where it is not simply the title again. */
  hoverTitle?: string;
}) {
  const mark = NOTICE_MARK[tone];
  const stacked = layout === "stack";
  // A title only outranks the block when something sits under it — and never on
  // a fault, where the block's own ink IS the message and lifting the first line
  // out of it would read as two subjects.
  const headline = detail !== undefined && tone !== "error";

  // The announced block: the sentence, and never a control. Unstyled on
  // purpose — it is a plain block box in a block flow, so it contributes no
  // geometry of its own and the paragraphs stack exactly as they did when they
  // were the text column's direct children.
  const message = (
    <div
      {...(announce ? { role: "status", "aria-live": "polite" as const, "aria-atomic": true } : {})}
    >
      <p
        className={cn("text-ui", headline && "font-medium text-foreground", truncate && "truncate")}
      >
        {title}
      </p>
      {detail === undefined ? null : (
        <p className={cn("mt-1 text-ui opacity-70", truncate && "truncate")}>{detail}</p>
      )}
    </div>
  );

  const text = (
    <div className="min-w-0 flex-1" title={hoverTitle}>
      {message}
      {stacked && actions !== undefined ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border",
        stacked ? "items-start p-4" : "items-center px-4 py-2",
        NOTICE_TONE[tone],
        className,
      )}
      {...rest}
    >
      {Icon === undefined ? null : (
        <Icon
          aria-hidden
          weight={mark.fill ? "fill" : undefined}
          className={cn("shrink-0", stacked ? "mt-1 size-4" : "size-3.5", mark.className)}
        />
      )}
      {text}
      {stacked ? null : actions}
    </div>
  );
}
