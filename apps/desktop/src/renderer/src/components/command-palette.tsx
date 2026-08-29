import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { ListNumbersIcon } from "@phosphor-icons/react/dist/csr/ListNumbers";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { Command } from "cmdk";
import type { ChatSessionRecord } from "@volli/shared";

import { runAutomationOnTicket } from "@renderer/components/automations/run-automation";
import {
  buildAutomationRunItems,
  buildCommandPaletteItems,
  buildEditorCommandItems,
  paletteRunContext,
  type CommandPaletteItems,
} from "@renderer/components/command-palette-model";
import { canGoToLine, runGoToLine } from "@renderer/editor/go-to-line";
import { useAutomationsStore } from "@renderer/stores/automations";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { MENU_LABEL_CMDK, MENU_ROW_STATE_CMDK } from "@renderer/components/ui/menu-classes";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
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

/** Universal ⌘K destination picker for tickets, open terminals, and durable chats. */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const projects = useProjectsStore((state) => state.projects);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const ticketsByProject = useBoardStore((state) => state.ticketsByProject);
  const planningChangeVersion = useBoardStore((state) => state.lastPlanningChange.version);
  const sessionsByOwner = useSessionsStore((state) => state.byOwner);
  const residentChatTitles = useChatSessionsStore(
    useShallow((state) => {
      const titles: Record<string, string> = {};
      for (const [sessionId, slice] of Object.entries(state.sessions)) {
        const title = slice.projection?.session.title;
        if (title !== null && title !== undefined) titles[sessionId] = title;
      }
      return titles;
    }),
  );
  const [chatSessions, setChatSessions] = React.useState<readonly ChatSessionRecord[]>([]);
  const [query, setQuery] = React.useState("");
  const openTicketId = useWorkspaceStore((state) =>
    selectedProjectId === null ? null : (state.byProject[selectedProjectId]?.openTicketId ?? null),
  );
  const automationsByProject = useAutomationsStore((state) => state.byProject);

  // The automations the selected project lists, re-read per open — same
  // staleness stance as the chat rows below: the palette's open IS the moment
  // a stale list would show.
  React.useEffect(() => {
    if (!open || selectedProjectId === null) return;
    void useAutomationsStore.getState().refresh(selectedProjectId);
  }, [open, selectedProjectId]);

  // "Run by name" targets the OPEN Ticket, resolved against the live board so
  // a remembered id whose Ticket is gone offers nothing (VC-126; the richer
  // choose-a-ticket surfaces are VC-127/VC-129).
  const selectedProject = projects.find((candidate) => candidate.id === selectedProjectId) ?? null;
  const runContext = open
    ? paletteRunContext(
        openTicketId,
        selectedProject,
        selectedProjectId === null ? [] : (ticketsByProject[selectedProjectId] ?? []),
      )
    : null;
  const automationRuns = buildAutomationRunItems(
    selectedProjectId === null ? [] : (automationsByProject[selectedProjectId] ?? []),
    runContext,
  );

  // Read at render rather than subscribed to: which editor is live is answered
  // at the moment a row runs, and the palette re-renders whenever it opens.
  const editorCommands = buildEditorCommandItems(open && canGoToLine());

  // Closed and invisible: every board/session mutation would otherwise
  // re-run this projects×tickets×sessions rebuild for nothing. Gating on
  // `open` keeps the closed palette free; the real derivation only runs once
  // the dialog is actually shown.
  const items = React.useMemo(
    () =>
      open
        ? buildCommandPaletteItems(
            projects,
            ticketsByProject,
            sessionsByOwner,
            selectedProjectId,
            chatSessions,
            residentChatTitles,
          )
        : EMPTY_COMMAND_PALETTE_ITEMS,
    [
      open,
      projects,
      ticketsByProject,
      sessionsByOwner,
      selectedProjectId,
      chatSessions,
      residentChatTitles,
    ],
  );

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // The palette is a global destination surface, so it reads durable chat rows
  // for every tracked project while open. Resident titles overlay those rows in
  // the model, making a just-auto-titled tab searchable before a later refresh.
  React.useEffect(() => {
    if (!open) {
      setChatSessions([]);
      return;
    }
    let current = true;
    void Promise.all(projects.map((project) => window.api.sessions.list({ projectId: project.id })))
      .then((results) => {
        if (!current) return;
        const failed = results.find((result) => !result.ok);
        if (failed !== undefined && !failed.ok) {
          toastError(`Couldn't load sessions: ${failed.error}`);
          return;
        }
        setChatSessions(
          results.flatMap((result) =>
            result.ok
              ? result.sessions.flatMap((row) => (row.kind === "chat" ? [row.record] : []))
              : [],
          ),
        );
      })
      .catch((error: unknown) => {
        if (current) {
          const message = error instanceof Error ? error.message : String(error);
          toastError(`Couldn't load sessions: ${message}`);
        }
      });
    return () => {
      current = false;
    };
  }, [open, planningChangeVersion, projects]);

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

        {automationRuns.length > 0 || selectedProjectId !== null ? (
          <Command.Group heading="Automations" className={MENU_LABEL_CMDK}>
            {automationRuns.map((item) => (
              <Command.Item
                key={`automation-run:${item.automationId}`}
                value={`run automation ${item.name} ${item.ticketDisplayId}`}
                keywords={[item.name, item.ticketDisplayId, "run", "automation"]}
                onSelect={() => {
                  // The palette closes now; the run navigates to the fresh
                  // Session itself the moment main answers (run-automation.ts).
                  void runAutomationOnTicket({
                    automationId: item.automationId,
                    ticketId: item.ticketId,
                  });
                  finishNavigation();
                }}
                className={PALETTE_ROW}
              >
                <LightningIcon aria-hidden className={PALETTE_ROW_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">{item.name}</span>
                  <span className="truncate text-label text-muted-foreground">
                    {item.ownership === "global" ? "All projects" : "This project"}
                  </span>
                </span>
                <span className="shrink-0 text-label text-muted-foreground">
                  Run on {item.ticketDisplayId}
                </span>
              </Command.Item>
            ))}
            {selectedProjectId !== null ? (
              <Command.Item
                key="automation-new"
                value="new automation create automation"
                keywords={["new", "create", "automation"]}
                onSelect={() => {
                  // Lands on the Automations page first, then opens the form.
                  // Only that page authors (VC-112), so a palette entry is a
                  // shortcut TO it rather than a second place to create one —
                  // and the new record appears in the list behind the dialog
                  // instead of vanishing into a surface nobody was looking at.
                  useWorkspaceStore.getState().setNav(selectedProjectId, "automations");
                  useAutomationsStore.getState().openEditor(selectedProjectId);
                  finishNavigation();
                }}
                className={PALETTE_ROW}
              >
                <PlusIcon aria-hidden className={PALETTE_ROW_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">New Automation…</span>
                  <span className="truncate text-label text-muted-foreground">
                    Name it, write Instructions, choose a Runtime
                  </span>
                </span>
              </Command.Item>
            ) : null}
          </Command.Group>
        ) : null}

        {editorCommands.length > 0 ? (
          <Command.Group heading="Editor" className={MENU_LABEL_CMDK}>
            {editorCommands.map((item) => (
              <Command.Item
                key={`editor:${item.id}`}
                value={`go to line jump ${item.title}`}
                keywords={["go to line", "goto", "jump", "line number"]}
                onSelect={() => {
                  finishNavigation();
                  // After the dialog is gone: Monaco's line prompt is an overlay
                  // widget of the editor and needs the focus this dialog is
                  // still holding — and hands back on close.
                  requestAnimationFrame(() => {
                    if (!runGoToLine()) {
                      toastError("Couldn't go to line: no editor is open.");
                    }
                  });
                }}
                className={PALETTE_ROW}
              >
                <ListNumbersIcon aria-hidden className={PALETTE_ROW_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">{item.title}</span>
                  <span className="truncate text-label text-muted-foreground">{item.hint}</span>
                </span>
                <span className="shrink-0 text-label text-muted-foreground">⌃G</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {items.sessions.length > 0 ? (
          <Command.Group heading="Sessions" className={MENU_LABEL_CMDK}>
            {items.sessions.map((item) => {
              const context =
                item.ticketDisplayId === null
                  ? `${item.projectName} · Project Session`
                  : `${item.ticketDisplayId} · ${item.ticketTitle}`;
              return (
                <Command.Item
                  key={`session:${item.sessionId}`}
                  value={`session ${item.title} ${context} ${item.projectName}`}
                  keywords={[item.title, context, item.projectName]}
                  onSelect={() => {
                    useProjectsStore.getState().select(item.projectId);
                    if (item.sessionKind === "chat") {
                      const chat = useChatSessionsStore.getState();
                      chat.adoptChatSession(item.sessionId);
                      if (item.scope.kind === "ticket") {
                        chat.openChatTab(item.scope.ticketId, item.sessionId);
                        useWorkspaceStore
                          .getState()
                          .openTicketWorkspace(item.projectId, item.scope.ticketId, {
                            tabId: chatTabId(item.sessionId),
                          });
                      } else {
                        // Home, with this Session's tab named in the same write.
                        // `openHome` leaves `openTicketId` alone — a Home Session
                        // tab keeps the ticket remembered behind it (VC-54).
                        chat.openChatTab(item.projectId, item.sessionId);
                        useWorkspaceStore
                          .getState()
                          .openHome(item.projectId, chatTabId(item.sessionId));
                      }
                    } else if (item.scope.kind === "ticket") {
                      useWorkspaceStore
                        .getState()
                        .openTicketSession(item.projectId, item.scope.ticketId, item.sessionId);
                    } else {
                      // Both ledgers: the terminal container's own active session
                      // AND Home's recorded tab. Recording is not optional now
                      // that the record defaults to the permanent Board tab —
                      // without it the palette would land you on the board.
                      useSessionsStore.getState().setActiveSession(item.projectId, item.sessionId);
                      useWorkspaceStore.getState().openHome(item.projectId, item.sessionId);
                    }
                    finishNavigation();
                  }}
                  className={PALETTE_ROW}
                >
                  {item.sessionKind === "chat" ? (
                    <ChatCircleIcon aria-hidden className={PALETTE_ROW_ICON} />
                  ) : (
                    <TerminalWindowIcon aria-hidden className={PALETTE_ROW_ICON} />
                  )}
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
