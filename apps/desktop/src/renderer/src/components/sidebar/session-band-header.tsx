/**
 * A session band's header, and the Previous band's own filter menu.
 *
 * The filter belongs to PREVIOUS, not to the list: every axis here narrows the
 * Previous band only, so the menu sits in that band's header rather than over
 * both. Unchecking Terminals does not — and per the listing model, should not —
 * empty the Active band of terminals. Active is what is happening; you do not
 * get to hide that. The same rule decided VC-196's scope axis: "Project
 * sessions" is a way of reading the archive, not a way of hiding running work.
 */
import * as React from "react";
import { BroomIcon } from "@phosphor-icons/react/dist/csr/Broom";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";

import type {
  SessionRowKind,
  SessionRowScope,
} from "@renderer/components/sidebar/active-session-listing";
import {
  isSessionBandFilterNarrowed,
  type SessionBandFilter,
} from "@renderer/components/sidebar/session-band-filter";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { cn } from "@renderer/lib/utils";

/** The sidebar's small-glyph tier, and the hit box this header draws around it. */
const GLYPH_PX = 12;
const TRIGGER_BOX_PX = 20;

/**
 * Half the difference between the trigger's box and its glyph — exactly how far
 * the glyph sits inside the column the rows' age defines, and so exactly how far
 * the box has to be pushed out for the two to share one right edge.
 *
 * Written as the subtraction rather than as `4` because it is a fact about the
 * trigger and not about the pane's fold: it is the same number at every fold
 * step, and the one number that moves if the glyph tier ever does.
 *
 * The box then ends 4px outside the ink column, which is correct rather than
 * residue — a hit target should be bigger than its mark — and still stops short
 * of the row pill beneath it, so the header's hover fill never reaches further
 * out than the rows'. Icons align to their ink, boxes to their neighbours'
 * boxes, and neither has to give.
 */
const FILTER_GLYPH_NUDGE = (TRIGGER_BOX_PX - GLYPH_PX) / 2;

/**
 * The band label and its count. `label` is written in sentence case and
 * uppercased by the sidebar's heading rule in `globals.css`, which is also what
 * puts it on the heading ink tier — the caps are a typographic treatment, not
 * the string.
 *
 * The count rides WITH the heading rather than dropping to the mute: the two
 * bracket the row from opposite edges and read as one unit.
 */
export function SessionBandHeader({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-6 items-center gap-2 px-2">
      <SectionHeading as="span">{label}</SectionHeading>
      <span className="text-label tabular-nums text-muted-foreground/70">{count}</span>
      <span className="ml-auto flex items-center">{children}</span>
    </div>
  );
}

/**
 * Kinds, scopes, and whether cleanup's decisions come back into view.
 *
 * A menu rather than a standing row of pills because this is a question asked
 * about once a week: the sidebar's steady state should be the list, not the
 * controls for it. The trigger tints when the filter is narrowed, so a list
 * that is hiding something never looks like a list that is empty.
 *
 * Three groups, separated, because they are three independent questions and a
 * reader who has narrowed one should be able to see at a glance that the others
 * are untouched. Scope (VC-196) sits BETWEEN kind and cleanup: it is a fact
 * about the Session, like kind, while Cleaned up is a fact about this list's own
 * housekeeping and belongs last for the same reason it always did.
 */
export function SessionBandFilterMenu({
  filter,
  onChange,
}: {
  filter: SessionBandFilter;
  onChange(next: SessionBandFilter): void;
}) {
  const narrowed = isSessionBandFilterNarrowed(filter);
  const toggleKind = (kind: SessionRowKind): void =>
    onChange({ ...filter, kinds: { ...filter.kinds, [kind]: !filter.kinds[kind] } });
  const toggleScope = (scope: SessionRowScope): void =>
    onChange({ ...filter, scopes: { ...filter.scopes, [scope]: !filter.scopes[scope] } });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filter"
          // Not `aria-pressed`: this opens a menu rather than toggling a state,
          // and the menu's own checkbox items are where that state is spoken.
          // The tint is the sighted half of the same fact.
          style={{ marginRight: -FILTER_GLYPH_NUDGE }}
          className={cn(
            "flex size-5 items-center justify-center rounded-sm ring-ring outline-hidden transition-colors hover:bg-sidebar-accent-veil hover:text-foreground focus-visible:ring-2",
            narrowed ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {/* `bold` OVERRIDES the audit, which records `regular` for this site
              (the retired icon-weight-audit lab scratch) — and it does so because the
              audit drew it at 14px and it ships at 12. CLAUDE.md's fifth clause
              is what wins here: bold is the small-size tier, because at ≤12px
              regular draws lighter than the label beside it, and coverage is
              scale-invariant so no `size-*` can fix that. Not `fill`, which is
              4.6x here — the widest gap in the app, and a different mark. */}
          <FunnelSimpleIcon weight="bold" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      {/* `onSelect` is preventDefault'd on every item so the menu survives a
          toggle: narrowing a list is usually two decisions, not one. */}
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuCheckboxItem
          checked={filter.kinds.chat}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleKind("chat")}
        >
          <ChatCircleIcon />
          Chats
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filter.kinds.terminal}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleKind("terminal")}
        >
          <TerminalWindowIcon />
          Terminals
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* The globe is the mark Project Sessions use in the row identity lane. */}
        <DropdownMenuCheckboxItem
          checked={filter.scopes.project}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleScope("project")}
        >
          <GlobeIcon />
          Project sessions
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filter.scopes.ticket}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleScope("ticket")}
        >
          <TicketIcon />
          Ticket sessions
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filter.showCleaned}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => onChange({ ...filter, showCleaned: !filter.showCleaned })}
        >
          <BroomIcon />
          Cleaned up
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
