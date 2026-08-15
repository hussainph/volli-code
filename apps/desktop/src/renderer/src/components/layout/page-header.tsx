import type { ReactNode } from "react";

import { cn } from "@renderer/lib/utils";

/**
 * What differs between a header on a workbench page and one on a reading page
 * — all of it, decided by one axis, because the thing that actually differs is
 * the *page* (docs/DESIGN.md's two content tiers), not the header.
 *
 * A **workbench** header is Tier B: it sits at the page gutter, holds its
 * title's width against the controls flowing beside it, and reads at the app's
 * body step so an 18px word doesn't shout across a row of 28px controls.
 *
 * A **reading** header is Tier A: it takes its measure and its horizontal
 * inset from the `<ContentColumn>` it is mounted in and adds none of its own,
 * and its identity block takes the column's width so a description wraps on
 * the measure instead of running past it. Its title is the pane's masthead, one
 * step above the `text-sm` section titles underneath it.
 */
const TIERS = {
  workbench: { inset: "px-gutter", identity: "shrink-0", title: "text-sm" },
  reading: { inset: "px-0", identity: "min-w-0 flex-1", title: "text-heading" },
} as const;

/**
 * The page-level header (docs/DESIGN.md): the row that names the surface you
 * are on and carries what acts on the whole of it. Every page composes this
 * rather than re-deriving a title row — the board's row and the settings pane's
 * masthead were two separate answers to the same object, and a third was about
 * to be written the next time a surface needed a title.
 *
 * The title is the page's `<h1>`. There is one page on screen at a time (the
 * sessions layer stays mounted but titles nothing), so a header that named
 * itself `h2` was an outline with no top.
 *
 * `actions` parks right and never shrinks; anything passed as `children` flows
 * between the title and that cluster and wraps with the row. Board relies on
 * exactly that split — its filter chips wrap onto a second line without ever
 * dragging the ordering/view/new cluster off the right edge with them.
 */
export function PageHeader({
  title,
  description,
  actions,
  variant = "workbench",
  className,
  children,
}: {
  title: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** The right-parked cluster. */
  actions?: ReactNode;
  /** Surface controls sharing the title's row. */
  children?: ReactNode;
  variant?: keyof typeof TIERS;
  className?: string;
}) {
  const tier = TIERS[variant];

  return (
    <header
      className={cn(
        "flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 py-4",
        tier.inset,
        className,
      )}
    >
      <div className={tier.identity}>
        <h1 className={cn(tier.title, "font-semibold")}>{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
