/**
 * A section, and the two shapes an action on one can take.
 *
 * ONE HEADER GRAMMAR for every section on both surfaces: icon · title ·
 * optional `(i)` · at most one action. The audit found sections with a
 * description, sections with two actions, sections with a segmented control
 * parked in the header — three different objects wearing the same name.
 *
 * There is deliberately **no `description` prop**. CLAUDE.md forbids
 * explanatory text under a section header, and an earlier pass of this
 * redesign added thirteen of them anyway. A rule you cannot express is a rule
 * you cannot break: what a section needs to say goes in an {@link InfoHint}
 * beside its title, which the reader opens or ignores.
 */
import type * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { InfoHint } from "./info-hint";

export function PrefSection({
  title,
  icon: Icon,
  hint,
  action,
  fill,
  children,
}: {
  title: string;
  icon?: PhosphorIcon;
  /** The `(i)`. A node, not a string, so it can carry a link. */
  hint?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * Absorb the height the pane has left over, for a section holding a table
   * that is the whole page. Needs every ancestor up to the shell to be a flex
   * column that can shrink — `PrefShell` arranges that when a category asks.
   */
  fill?: boolean;
  children: React.ReactNode;
}) {
  return (
    // One fill, no border, no internal rules. This card already sits inside
    // the app shell's framed content card, and a frame here is what turns a
    // pane into boxes inside boxes: a bordered card holding a bordered table
    // holding a bordered search field.
    <section className={cn("rounded-lg bg-card px-4 py-4", fill && "flex min-h-0 flex-1 flex-col")}>
      {/* The rule under the header is DELIBERATE and drawn here, and the
          wrapper below is what keeps it to ONE line.

          A row draws `border-t` with `first:border-t-0`, which only suppresses
          the top rule when the row is genuinely its parent's first child. With
          the rows as direct children of this `<section>`, THIS header is the
          first child, `first:` matched nothing, and every section drew the
          header's rule and the first row's rule eight pixels apart. */}
      {/* `items-center`, not `items-start`: an action can be taller than the
          title line (the provider list parks a search field here), and
          top-aligning it left the field visibly off the title's axis. */}
      <div className="mb-2 flex items-center justify-between gap-4 border-b border-border/50 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
          <h2 data-slot="pref-section-title" className="min-w-0 truncate text-sm font-semibold">
            {title}
          </h2>
          {hint ? <InfoHint label={title}>{hint}</InfoHint> : null}
        </div>
        {action}
      </div>
      {/* Rows live in their own box so `first:` has something true to say. */}
      {/* `|| undefined` so a non-filling section emits no `class` at all rather
          than an empty one — `cn(false)` returns "". */}
      <div className={cn(fill && "flex min-h-0 flex-1 flex-col") || undefined}>{children}</div>
    </section>
  );
}

/** A section action with a word on it. */
export function SectionAction({
  label,
  icon: Icon,
  disabled,
  onAct,
}: {
  label: string;
  icon?: PhosphorIcon;
  disabled?: boolean;
  onAct?: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" disabled={disabled} onClick={onAct}>
      {Icon ? <Icon /> : null}
      {label}
    </Button>
  );
}

/** A section action that is only a glyph. Its name lives in `aria-label`. */
export function SectionIconAction({
  label,
  icon: Icon = ArrowClockwiseIcon,
  busy = false,
  disabled,
  onAct,
}: {
  label: string;
  icon?: PhosphorIcon;
  /** Spins the glyph. A refresh that gives no sign of running reads as broken. */
  busy?: boolean;
  disabled?: boolean;
  onAct?: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      disabled={disabled ?? busy}
      onClick={onAct}
    >
      <Icon className={busy ? "animate-spin" : undefined} />
    </Button>
  );
}
