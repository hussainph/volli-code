import * as React from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { Command } from "cmdk";

import {
  buildCommandPaletteItems,
  type CommandPaletteItems,
} from "@renderer/components/command-palette-model";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { MENU_LABEL_CMDK, MENU_ROW_STATE_CMDK } from "@renderer/components/ui/menu-classes";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** No tickets/sessions to show while closed — keeps the derivation below free. */
const EMPTY_COMMAND_PALETTE_ITEMS: CommandPaletteItems = { tickets: [], sessions: [] };

/**
 * The palette row, written once for both groups — they were two copies of one
 * string, which is how the two drifted apart in the first place.
 *
 * It cannot take `MENU_ROW` wholesale: a menu row is a 28px single-line
 * control and this one stacks a title over its context. What it can take is the
 * part that has nothing to do with height — cmdk's selected/disabled recipe —
 * so the palette highlights exactly like every menu in the app.
 *
 * The height is the two line boxes plus `py-2`: `text-ui` (20) over
 * `text-label` (16) plus 16 is 52. Nothing here pins it, and every value is a
 * ladder rung (docs/DESIGN.md's five steps — no half-steps here).
 */
const PALETTE_ROW = `flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 outline-none ${MENU_ROW_STATE_CMDK}`;

/** The row's leading glyph: bare and muted. */
const PALETTE_ROW_ICON = "size-4 shrink-0 text-muted-foreground";

/** Universal ⌘K destination picker for every ticket and every open session. */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const projects = useProjectsStore((state) => state.projects);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const ticketsByProject = useBoardStore((state) => state.ticketsByProject);
  const sessionsByOwner = useSessionsStore((state) => state.byOwner);
  const [query, setQuery] = React.useState("");

  // Closed and invisible: every board/session mutation would otherwise
  // re-run this projects×tickets×sessions rebuild for nothing. Gating on
  // `open` keeps the closed palette free; the real derivation only runs once
  // the dialog is actually shown.
  const items = React.useMemo(
    () =>
      open
        ? buildCommandPaletteItems(projects, ticketsByProject, sessionsByOwner, selectedProjectId)
        : EMPTY_COMMAND_PALETTE_ITEMS,
    [open, projects, ticketsByProject, sessionsByOwner, selectedProjectId],
  );

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const finishNavigation = React.useCallback(() => {
    useUiStore.getState().setSettingsOpen(false);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search tickets and sessions"
      loop
      // The app's one `--scrim`, plus a blur no other overlay takes. This used
      // to be a notch heavier than the dialog's — 35/55 against 30/50, a
      // difference nobody could name behind a backdrop it also blurs, and the
      // third and fourth spellings of one wash. The blur is what makes this
      // overlay the exception; the wash is not.
      overlayClassName="fixed inset-0 z-50 bg-scrim backdrop-blur-[2px]"
      contentClassName="fixed top-[18%] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-overlay outline-none"
    >
      {/* 36px, matching the footer strip: the header was 48 — a full rung taller
          than any control this app draws — so the field read as a hero banner
          rather than as the search box the rows answer to. `text-ui` is the
          same size `ui/command.tsx`'s field takes; there is one command-input
          type size, not one per surface. */}
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search tickets and sessions…"
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded-md border border-border bg-muted px-1 py-1 text-label text-muted-foreground">
          esc
        </kbd>
      </div>
      <Command.List className="max-h-[min(460px,60vh)] overflow-y-auto p-2 [scrollbar-gutter:stable]">
        <Command.Empty className={EMPTY_INLINE}>No matching tickets or sessions.</Command.Empty>

        {items.sessions.length > 0 ? (
          <Command.Group heading="Sessions" className={MENU_LABEL_CMDK}>
            {items.sessions.map((item) => {
              const context =
                item.ticketDisplayId === null
                  ? `${item.projectName} · Scratch`
                  : `${item.ticketDisplayId} · ${item.ticketTitle}`;
              return (
                <Command.Item
                  key={`session:${item.sessionId}`}
                  value={`session ${item.title} ${context} ${item.projectName}`}
                  keywords={[item.title, context, item.projectName]}
                  onSelect={() => {
                    useProjectsStore.getState().select(item.projectId);
                    if (item.scope.kind === "ticket") {
                      useWorkspaceStore
                        .getState()
                        .openTicketSession(item.projectId, item.scope.ticketId, item.sessionId);
                    } else {
                      useWorkspaceStore.getState().setNav(item.projectId, "sessions");
                      useSessionsStore.getState().setActiveSession(item.projectId, item.sessionId);
                    }
                    finishNavigation();
                  }}
                  className={PALETTE_ROW}
                >
                  <TerminalWindowIcon aria-hidden className={PALETTE_ROW_ICON} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui font-medium">{item.title}</span>
                    <span className="truncate text-label text-muted-foreground">{context}</span>
                  </span>
                  <span className="shrink-0 text-label text-muted-foreground">Open session</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : null}

        <Command.Group
          heading="Tickets"
          className={cn("mt-1 border-t border-border pt-1", MENU_LABEL_CMDK)}
        >
          {items.tickets.map((item) => (
            <Command.Item
              key={`ticket:${item.ticketId}`}
              value={`ticket ${item.displayId} ${item.title} ${item.projectName}`}
              keywords={[item.displayId, item.title, item.projectName]}
              onSelect={() => {
                useProjectsStore.getState().select(item.projectId);
                useWorkspaceStore.getState().openTicketWorkspace(item.projectId, item.ticketId, {
                  tabId: TICKET_BODY_TAB_ID,
                });
                finishNavigation();
              }}
              className={PALETTE_ROW}
            >
              <TicketIcon aria-hidden className={PALETTE_ROW_ICON} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui font-medium">{item.title}</span>
                <span className="truncate text-label text-muted-foreground">
                  <span className="font-mono">{item.displayId}</span> · {item.projectName}
                </span>
              </span>
              <span className="shrink-0 text-label text-muted-foreground">Open ticket</span>
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex h-9 items-center justify-end gap-4 border-t border-border px-4 text-label text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
      </div>
    </Command.Dialog>
  );
}
