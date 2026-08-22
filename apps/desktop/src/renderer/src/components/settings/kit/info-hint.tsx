/**
 * The `(i)` — the whole prose budget of a settings surface.
 *
 * CLAUDE.md's copy rule is that controls talk: no `description` under a
 * section, no tutorial tooltips, no paragraphs under a control. But a value
 * that resolves through layers genuinely is not self-describing, and the
 * honest resolution is to make the explanation *available* rather than
 * *unavoidable*. A hint someone summons is not the surface lecturing them.
 *
 * Opens on hover AND focus AND click, because a hover-only affordance is
 * unreachable by keyboard. A real `<button>` inside a `Popover` rather than a
 * `Tooltip`, so a hint that needs a link in it can have one.
 *
 * TWO THINGS THAT ONLY SHOW UP WHEN YOU DRIVE IT, both load-bearing:
 *
 *  1. It opens `side="top"`. From a section header, `bottom` puts the
 *     explanation directly on top of the rows it is explaining — a hint that
 *     covers its own subject is worse than no hint. Radix flips it only when
 *     there is genuinely no room.
 *  2. The panel is `pointer-events-none` unless `interactive`. Otherwise it
 *     swallows the next click — which is exactly the click the hint just
 *     persuaded someone to make. Only a hint with a link or a copyable value
 *     should buy its way out of that.
 */
import * as React from "react";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";

import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

/** Travelling the gap between the button and the panel must not dismiss it. */
const CLOSE_GRACE_MS = 120;

export function InfoHint({
  label,
  interactive = false,
  children,
  className,
}: {
  /** What this explains. Becomes the button's accessible name. */
  label: string;
  /** The panel holds something clickable. Costs the click-through. */
  interactive?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = React.useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
  }, []);

  const scheduleClose = React.useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }, [cancelClose]);

  React.useEffect(() => cancelClose, [cancelClose]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`About ${label}`}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
          className,
        )}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className={cn(
          "w-auto max-w-64 p-2 text-ui text-muted-foreground",
          !interactive && "pointer-events-none",
        )}
        // An interactive panel must let focus in, or its link is unreachable
        // by keyboard: Tab from the trigger would skip straight past it.
        onOpenAutoFocus={interactive ? undefined : (event) => event.preventDefault()}
        onMouseEnter={interactive ? cancelClose : undefined}
        onMouseLeave={interactive ? scheduleClose : undefined}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
