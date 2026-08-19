import * as React from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";

import { Markdown } from "@renderer/components/ticket/markdown";
import { COMMENT_CLAMP_PX, planClamp } from "@renderer/components/ticket/clamp-policy";
import { cn } from "@renderer/lib/utils";

/**
 * Comment markdown with a collapse (VC-99): agent comments can run to hundreds
 * of lines, and an uncapped block in the Activity feed turns one verbose
 * comment into an extensive scroll. Content over {@link COMMENT_CLAMP_PX}
 * renders clamped — the cap as an inline `maxHeight` from the policy constant,
 * never a parallel Tailwind class, so the number and the style cannot drift —
 * with a gradient fade into the card and a "Show more"/"Show less" toggle in
 * the same visual language as the feed's bunch rows (`+N more ⌄`). Content
 * that fits renders untouched: no cap, no fade, no toggle.
 *
 * Measurement observes the INNER content element, which is never itself
 * clamped, so its height is always the true content height — the outer box
 * clips it, and a `ResizeObserver` catches late reflow (an image loading, a
 * table widening) rather than only the initial paint. The first measurement
 * runs in a layout effect, before the browser paints, so a long comment never
 * flashes unclamped.
 */
export function ClampedMarkdown({ source, className }: { source: string; className?: string }) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  // `null` until the first measurement: `planClamp` treats it as "fits", so the
  // pre-measure frame is simply the unclamped render the layout effect then
  // corrects before paint.
  const [contentHeight, setContentHeight] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const measure = (): void => setContentHeight(content.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [source]);

  const { overflowing, clamped } = planClamp(contentHeight, COMMENT_CLAMP_PX, expanded);

  return (
    <div className={cn("relative", className)}>
      {/* The clamp box is itself the fade's anchor: the outer wrapper also
          holds the toggle below it, so a wrapper-anchored fade would dissolve
          the button instead of the clipped text edge. */}
      <div
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: COMMENT_CLAMP_PX } : undefined}
      >
        <div ref={contentRef}>
          <Markdown source={source} />
        </div>
        {clamped ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-card"
          />
        ) : null}
      </div>

      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={!clamped}
          className="mt-1 flex items-center gap-1 rounded-sm text-ui text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          {clamped ? "Show more" : "Show less"}
          <CaretDownIcon
            className={cn("size-3 shrink-0 transition-transform", !clamped && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}
