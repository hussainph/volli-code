import * as React from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { Command } from "cmdk";

import {
  buildCommandPaletteItems,
  type CommandPaletteItems,
} from "@renderer/components/command-palette-model";
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
      overlayClassName="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]"
      contentClassName="fixed top-[18%] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none"
    >
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search tickets and sessions…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-label text-muted-foreground">
          esc
        </kbd>
      </div>
      <Command.List className="max-h-[min(460px,60vh)] overflow-y-auto p-2 [scrollbar-gutter:stable]">
        <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
          No matching tickets or sessions.
        </Command.Empty>

        {items.sessions.length > 0 ? (
          <Command.Group
            heading="Sessions"
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
          >
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
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                    <TerminalWindowIcon weight="fill" className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{context}</span>
                  </span>
                  <span className="shrink-0 text-label text-muted-foreground">Open session</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : null}

        <Command.Group
          heading="Tickets"
          className="mt-1 border-t border-border pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
        >
          {items.tickets.map((item) => (
            <Command.Item
              key={`ticket:${item.ticketId}`}
              value={`ticket ${item.displayId} ${item.title} ${item.projectName}`}
              keywords={[item.displayId, item.title, item.projectName]}
              onSelect={() => {
                useProjectsStore.getState().select(item.projectId);
                const workspace = useWorkspaceStore.getState();
                workspace.setNav(item.projectId, "board");
                workspace.openTicket(item.projectId, item.ticketId);
                workspace.setTicketActiveTab(item.projectId, item.ticketId, "doc");
                finishNavigation();
              }}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                <TicketIcon weight="fill" className="size-3.5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{item.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{item.displayId}</span> · {item.projectName}
                </span>
              </span>
              <span className="shrink-0 text-label text-muted-foreground">Open ticket</span>
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex h-9 items-center justify-end gap-3 border-t border-border px-3 text-label text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
      </div>
    </Command.Dialog>
  );
}
