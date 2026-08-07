/**
 * A session band's header, and the Previous band's own filter menu.
 *
 * The filter belongs to PREVIOUS, not to the list: `kinds` narrows the Previous
 * band only, so the menu sits in that band's header rather than over both.
 * Unchecking Terminals does not — and per the listing model, should not — empty
 * the Active band of terminals. Active is what is happening; you do not get to
 * hide that.
 */
import * as React from "react";
import { BroomIcon } from "@phosphor-icons/react/dist/csr/Broom";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import type { SessionRowKind } from "@renderer/components/sidebar/active-session-listing";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

/** What the Previous band is currently showing. */
export interface SessionBandFilter {
  kinds: Record<SessionRowKind, boolean>;
  showCleaned: boolean;
}

export const DEFAULT_SESSION_BAND_FILTER: SessionBandFilter = {
  kinds: { chat: true, terminal: true },
  showCleaned: false,
};

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
      <span className="text-label font-medium uppercase text-muted-foreground">{label}</span>
      <span className="text-label tabular-nums text-muted-foreground/70">{count}</span>
      <span className="ml-auto flex items-center">{children}</span>
    </div>
  );
}

/**
 * Kinds, and whether cleanup's decisions come back into view.
 *
 * A menu rather than a standing row of pills because this is a question asked
 * about once a week: the sidebar's steady state should be the list, not the
 * controls for it. The trigger tints when the filter is narrowed, so a list
 * that is hiding something never looks like a list that is empty.
 */
export function SessionBandFilterMenu({
  filter,
  onChange,
}: {
  filter: SessionBandFilter;
  onChange(next: SessionBandFilter): void;
}) {
  const narrowed = !filter.kinds.chat || !filter.kinds.terminal || filter.showCleaned;
  const toggleKind = (kind: SessionRowKind): void =>
    onChange({ ...filter, kinds: { ...filter.kinds, [kind]: !filter.kinds[kind] } });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filter"
          className={cn(
            "flex size-5 items-center justify-center rounded-sm ring-sidebar-ring outline-hidden transition-colors hover:bg-sidebar-accent-veil hover:text-sidebar-accent-foreground focus-visible:ring-2",
            narrowed ? "text-sidebar-accent-foreground" : "text-muted-foreground",
          )}
        >
          <FunnelSimpleIcon weight="fill" className="size-3.5" />
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
          <ChatCircleIcon weight="fill" />
          Chats
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filter.kinds.terminal}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleKind("terminal")}
        >
          <TerminalWindowIcon weight="fill" />
          Terminals
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filter.showCleaned}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => onChange({ ...filter, showCleaned: !filter.showCleaned })}
        >
          <BroomIcon weight="fill" />
          Cleaned up
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
