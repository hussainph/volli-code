"use client";

import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  /** One full sweep, in seconds. */
  duration?: number;
}

/**
 * A highlight travelling along a live status line.
 *
 * Three layers, and the reason there are three is that the sweep must cost the
 * compositor and nothing else. The obvious shape — one `bg-clip-text` copy whose
 * `background-position` animates — repaints the glyph raster on the main thread
 * every frame for as long as the line is on screen, and it was doing that from a
 * JS timeline besides (Framer wrote the style per frame): 0.1–0.4ms of every
 * 16.7ms frame for a single line, scaling with how much text there is to
 * re-raster. This shape measures at zero against the same instrument, because
 * `transform` is the one property the compositor can advance without asking
 * style or paint anything.
 *
 * So the band moves and the words do not. `.chat-shimmer-band` carries the soft
 * gradient MASK and sweeps across the box; `.chat-shimmer-ink` is the bright
 * copy of the words inside it, running the exact inverse translation over the
 * same duration on the same linear curve, which pins it to the same pixels the
 * base copy occupies. Both are pure transforms, both in percentages of boxes
 * that are the same width, so the cancellation is exact at every instant rather
 * than approximately right.
 *
 * The band is a fixed 60% of the label's width, and the `spread` prop that used
 * to set it is gone. `spread` was in px and resolved as `children.length * 2`,
 * which at this file's type size lands within a few points of 60% of the
 * rendered width for every string, short or long — a proportion wearing px
 * clothing. The one call site never passed a value.
 *
 * Reduced motion drops the overlay outright rather than parking it mid-sweep.
 * A frozen highlight halfway along a word reads as a rendering bug, not as
 * stillness — the same call the sidebar's title sweep makes in `globals.css`.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
}: TextShimmerProps) => {
  const reducedMotion = useReducedMotion();

  // Two layers, and the order matters. The words below are painted by ordinary
  // `color`, inherited from the row; the sweep above is an aria-hidden copy of
  // the same words in the highlight tier. A single-element version has to set
  // `color: transparent` so a clip can show through, which makes the gradient
  // the sole source of colour — and then any unresolvable token in it (a pruned
  // `--color-*`, or `currentColor`, which by then *is* the transparency) drops
  // the whole declaration and the text renders as nothing at full width. Split
  // this way the worst case is a line that does not shimmer.
  return (
    <Component className={cn("relative inline-block", className)}>
      {children}
      {reducedMotion ? null : (
        <span
          aria-hidden
          // `select-none` as well as `aria-hidden`: the overlay is a second copy
          // of the same words, so without it a drag-select would carry the line
          // twice into the clipboard.
          className="chat-shimmer pointer-events-none absolute inset-0 select-none"
          style={{ "--chat-shimmer-duration": `${duration}s` } as CSSProperties}
        >
          <span className="chat-shimmer-band">
            {/* The caller's own class comes first so `truncate` reaches this
                copy too — the bright words must clip and ellipsize exactly
                where the base words do, or the sweep runs past the fade. */}
            <span className={cn(className, "chat-shimmer-ink")}>{children}</span>
          </span>
        </span>
      )}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
