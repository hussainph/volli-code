import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import type { Icon } from "@phosphor-icons/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { ListNumbersIcon } from "@phosphor-icons/react/dist/csr/ListNumbers";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useDialogFocusReturn } from "@renderer/hooks/use-dialog-focus-return";
import { sessionProvenanceHoverLine } from "@volli/shared";

import { runAutomationOnTicket } from "@renderer/components/automations/run-automation";
import {
  buildAutomationRunItems,
  buildCommandPaletteItems,
  buildEditorCommandItems,
  paletteRunContext,
  type CommandPaletteItems,
} from "@renderer/components/command-palette-model";
import {
  PALETTE_SCOPES,
  automationRowMatch,
  commandPaletteFilter,
  paletteEmptyCopy,
  paletteScopeById,
  parsePaletteScopeQuery,
  sessionRowContext,
  sessionRowMatch,
  showScopeSuggestions,
  slicePaletteSection,
  ticketRowMatch,
  type PaletteScopeId,
} from "@renderer/components/command-palette-search";
import { canGoToLine, runGoToLine } from "@renderer/editor/go-to-line";
import { useAutomationsStore } from "@renderer/stores/automations";
import { SessionProvenanceMark } from "@renderer/components/sessions/session-provenance-mark";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { MENU_LABEL_CMDK, MENU_ROW_STATE_CMDK } from "@renderer/components/ui/menu-classes";
import { markPerfPhase, PERF_PHASE } from "@renderer/lib/perf-marks";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  mergedProjectSessionRows,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { toastError } from "@renderer/lib/toast";
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

/** cmdk's convenience Dialog hides Radix's focus lifecycle callbacks. Keep the
 * same chrome, but own the scope so keyboard dismissal can restore its invoker.
 */
function PaletteDialog({
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: CommandPaletteProps & {
  children: React.ReactNode;
  onCloseAutoFocus(event: Event): void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed top-[18%] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-overlay outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            Search tickets and sessions
          </DialogPrimitive.Title>
          <Command label="Search tickets and sessions" filter={commandPaletteFilter} loop>
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** No tickets/sessions to show while closed — keeps the derivation below free. */
const EMPTY_COMMAND_PALETTE_ITEMS: CommandPaletteItems = { tickets: [], sessions: [] };

/** Nothing expanded — the shared reset value, so the resets compare equal. */
const NOTHING_EXPANDED: ReadonlySet<PaletteScopeId> = new Set();

/** Each scope suggestion row wears its section's own glyph. */
const SCOPE_ICONS: Record<PaletteScopeId, Icon> = {
  tickets: TicketIcon,
  sessions: ChatCircleIcon,
  automations: LightningIcon,
};

/**
 * The palette row, written once for both groups — they were two copies of one
 * string, which is how the two drifted apart in the first place.
 *
 * It cannot take `MENU_ROW` wholesale: a menu row is a 28px single-line
 * control and this one stacks a title over its context. What it can take is the
 * part that has nothing to do with height — cmdk's selected/disabled recipe —
 * so the palette highlights exactly like every menu in the app, cursor
 * included: a row answers a press with the arrow, never the hand
 * (`docs/DESIGN.md`'s cursor rule).
 *
 * The height is the two line boxes plus `py-2`: `text-ui` (20) over
 * `text-label` (16) plus 16 is 52. Nothing here pins it, and every value is a
 * ladder rung (docs/DESIGN.md's five steps — no half-steps here).
 */
const PALETTE_ROW = `flex cursor-default items-center gap-2 rounded-lg px-2 py-2 outline-none ${MENU_ROW_STATE_CMDK}`;

/** The row's leading glyph: bare and muted. */
const PALETTE_ROW_ICON = "size-4 shrink-0 text-muted-foreground";

interface ShowAllRowProps {
  sectionId: PaletteScopeId;
  /** The section's full match count — what expanding reveals. */
  total: number;
  /** The section's plural noun, spoken in the row. */
  noun: string;
  onExpand: (sectionId: PaletteScopeId) => void;
}

/**
 * The "Show all N …" row a truncated section ends with (VC-205).
 *
 * `forceMount` because its value is not supposed to match the search — cmdk
 * mounts it on our say-so, and the zero score it earns under a query sorts it
 * after every real match natively. With no query there is no sort and it sits
 * where it is rendered: last in its group.
 */
function ShowAllRow({ sectionId, total, noun, onExpand }: ShowAllRowProps) {
  return (
    <Command.Item
      forceMount
      value={`show all ${noun}`}
      onSelect={() => onExpand(sectionId)}
      className={PALETTE_ROW}
    >
      <CaretDownIcon aria-hidden className={PALETTE_ROW_ICON} />
      <span className="min-w-0 flex-1 truncate text-ui font-medium">
        Show all {total} {noun}
      </span>
    </Command.Item>
  );
}

/**
 * Universal ⌘K destination picker for tickets, open terminals, closed terminal
 * records, and durable chats. Tickets lead (VC-205); each section truncates behind a "Show all"
 * row; and a completed `@` token — typed, or picked from the rows `@` itself
 * surfaces — narrows the palette to one section.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { restoreFocus, skipFocusReturn } = useDialogFocusReturn(open);

  const projects = useProjectsStore((state) => state.projects);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const ticketsByProject = useBoardStore((state) => state.ticketsByProject);
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
  /**
   * Every tracked project's durable Session rows, read from the shared cache
   * (VC-385).
   *
   * This used to be three pieces of component state filled by the palette's
   * own `sessions.list` call per project on EVERY open. That fetch is one
   * blocking main-process transaction over a project's whole roster (VC-388) —
   * 1,198 Sessions in the benchmark's `real` fixture — and it sat inside the
   * window VC-385 was measuring a ticket switch in, repeated every time ⌘K was
   * pressed. `project-sessions` already holds this answer, seeded once per
   * project and kept current by the `volli:session-activity` push channel, so
   * the palette reads it instead of asking again.
   *
   * The three shapes are what the palette draws: chat rows, durable TERMINAL
   * rows (VC-290 — a terminal closed an hour ago is a destination too), and
   * the sparse provenance map (VC-131) that marks who started each Session.
   */
  const projectIds = React.useMemo(() => projects.map((project) => project.id), [projects]);
  // Subscribed to the store's `byProject` map, then merged in a memo — NOT
  // merged inside the selector. The fold allocates fresh arrays every call, so
  // a selector returning it is never equal to its own previous result, and
  // `useShallow` over it re-renders forever. The map's identity changes exactly
  // when a project's rows change, which is the dependency this actually has.
  const byProject = useProjectSessionsStore((state) => state.byProject);
  const {
    chat: chatSessions,
    terminal: terminalSessions,
    provenance: sessionProvenance,
  } = React.useMemo(
    // `open` is load-bearing, not decoration. `applyActivity` allocates a new
    // `byProject` for every `volli:session-activity` push, and this palette is
    // always mounted — so without the gate each push would wake it and fold
    // every project's whole roster while the palette is closed and nobody is
    // looking. It is the same rule the items memo below states ("Gating on
    // `open` keeps the closed palette free") and the same one every other
    // consumer of this store keeps by narrowing to a single project.
    () => (open ? mergedProjectSessionRows(byProject, projectIds) : EMPTY_PROJECT_SESSION_ROWS),
    [open, byProject, projectIds],
  );
  const [query, setQuery] = React.useState("");
  // The `@` scope chip (VC-205): a completed `@sessions` narrows the palette
  // to one section. It is state beside the query, not text inside it, so the
  // token never pollutes what cmdk's native filter scores rows against.
  const [scope, setScope] = React.useState<PaletteScopeId | null>(null);
  // Which sections have had their "Show all" row taken. Reset on every
  // keystroke: a changed query is a new result set, and a new result set
  // starts truncated again.
  const [expanded, setExpanded] = React.useState<ReadonlySet<PaletteScopeId>>(NOTHING_EXPANDED);
  const openTicketId = useWorkspaceStore((state) =>
    selectedProjectId === null ? null : (state.byProject[selectedProjectId]?.openTicketId ?? null),
  );
  const automationsByProject = useAutomationsStore((state) => state.byProject);

  // The palette is on screen (VC-385). A ticket switch driven from ⌘K spends
  // everything between this and the switch's commit on finding the row, and
  // that stretch was inside the old one-number measurement with no way to see
  // it.
  React.useEffect(() => {
    if (!open) return;
    markPerfPhase(PERF_PHASE.commandPaletteOpen);
  }, [open]);

  // The automations the selected project lists, re-read on every open: this
  // list has no push channel, so the palette's open IS the moment a stale one
  // would show. The Session rows no longer work this way — they come from a
  // pushed cache (VC-385) and are read once per project, not once per open.
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
            sessionProvenance,
            terminalSessions,
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
      sessionProvenance,
      terminalSessions,
    ],
  );

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setScope(null);
      setExpanded(NOTHING_EXPANDED);
    }
  }, [open]);

  const handleQueryChange = React.useCallback((next: string) => {
    setExpanded(NOTHING_EXPANDED);
    // A leading "@sessions " becomes the chip. Any remainder stays in the
    // input, so typing and pasting "@sessions auth" have identical meaning.
    const parsed = parsePaletteScopeQuery(next);
    if (parsed !== null) {
      setScope(parsed.scope.id);
      setQuery(parsed.query);
      return;
    }
    setQuery(next);
  }, []);

  const applyScope = React.useCallback((next: PaletteScopeId | null) => {
    setScope(next);
    setQuery("");
    setExpanded(NOTHING_EXPANDED);
  }, []);

  const expandSection = React.useCallback((sectionId: PaletteScopeId) => {
    setExpanded((previous) => new Set(previous).add(sectionId));
  }, []);

  // Which rows each section mounts: every row the palette's cmdk filter would
  // keep, truncated behind a "Show all" row past the section limit. The same
  // filter scores this slice and the mounted rows, so truncation cannot drift
  // from native matching or VC-205's Ticket-section priority.
  const ticketSlice = React.useMemo(
    () => slicePaletteSection(items.tickets, ticketRowMatch, query, expanded.has("tickets")),
    [items.tickets, query, expanded],
  );
  const sessionSlice = React.useMemo(
    () => slicePaletteSection(items.sessions, sessionRowMatch, query, expanded.has("sessions")),
    [items.sessions, query, expanded],
  );
  const automationSlice = slicePaletteSection(
    automationRuns,
    automationRowMatch,
    query,
    expanded.has("automations"),
  );

  const scopeDef = paletteScopeById(scope);
  const showTickets = scope === null || scope === "tickets";
  const showSessions = scope === null || scope === "sessions";
  const showAutomations = scope === null || scope === "automations";

  // The palette is a global destination surface, so every tracked project's
  // baseline has to exist before it can draw one list over all of them.
  // `ensure` is at-most-once per project and never twice at a time, so a
  // project already seeded by the sidebar or Home costs nothing here and the
  // second ⌘K of a session issues no reads at all — the push channel has been
  // carrying the changes since the first one. Resident titles still overlay
  // these rows in the model, so a just-auto-titled tab is searchable before
  // any refresh.
  React.useEffect(() => {
    if (!open) return;
    const ensure = useProjectSessionsStore.getState().ensure;
    void Promise.all(projectIds.map((projectId) => ensure(projectId))).then(() => {
      markPerfPhase(PERF_PHASE.commandPaletteSessionsListed);
    });
  }, [open, projectIds]);

  const finishNavigation = React.useCallback(() => {
    // Navigation intentionally hands focus to the destination rather than the
    // palette's invoker. Ordinary dismissal restores after the focus scope closes.
    skipFocusReturn();
    useUiStore.getState().setSettingsOpen(false);
    onOpenChange(false);
  }, [onOpenChange, skipFocusReturn]);

  return (
    <PaletteDialog open={open} onOpenChange={onOpenChange} onCloseAutoFocus={restoreFocus}>
      {/* 36px, matching the footer strip: the header was 48 — a full rung taller
          than any control this app draws — so the field read as a hero banner
          rather than as the search box the rows answer to. `text-ui` is the
          same size `ui/command.tsx`'s field takes; there is one command-input
          type size, not one per surface. */}
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {scopeDef !== null ? (
          <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-accent px-2 text-ui font-medium text-foreground">
            {scopeDef.label}
          </span>
        ) : null}
        <Command.Input
          autoFocus
          value={query}
          onValueChange={handleQueryChange}
          onKeyDown={(event) => {
            // The chip deletes like the token it replaced: Backspace at an
            // empty field clears the scope.
            if (event.key === "Backspace" && query === "" && scope !== null) applyScope(null);
          }}
          placeholder={
            scopeDef === null
              ? "Search tickets and sessions…"
              : `Search ${scopeDef.label.toLowerCase()}…`
          }
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded-md border border-border bg-muted px-1 py-1 text-label text-muted-foreground">
          esc
        </kbd>
      </div>
      <Command.List className="max-h-[min(460px,60vh)] overflow-y-auto p-2 [scrollbar-gutter:stable]">
        <Command.Empty className={EMPTY_INLINE}>{paletteEmptyCopy(scope)}</Command.Empty>

        {showScopeSuggestions(query, scope) ? (
          <Command.Group heading="Filter" className={MENU_LABEL_CMDK}>
            {PALETTE_SCOPES.map((candidate) => {
              const ScopeIcon = SCOPE_ICONS[candidate.id];
              return (
                <Command.Item
                  key={`scope:${candidate.id}`}
                  value={candidate.token}
                  keywords={[candidate.label]}
                  onSelect={() => applyScope(candidate.id)}
                  className={PALETTE_ROW}
                >
                  <ScopeIcon aria-hidden className={PALETTE_ROW_ICON} />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    Only {candidate.label.toLowerCase()}
                  </span>
                  <span className="shrink-0 font-mono text-label text-muted-foreground">
                    {candidate.token}
                  </span>
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : null}

        {showTickets && ticketSlice.visible.length > 0 ? (
          <Command.Group heading="Tickets" className={MENU_LABEL_CMDK}>
            {ticketSlice.visible.map(({ row: item, match }) => (
              <Command.Item
                key={`ticket:${item.ticketId}`}
                value={match.value}
                keywords={match.keywords}
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
            {ticketSlice.hiddenCount > 0 ? (
              <ShowAllRow
                sectionId="tickets"
                total={ticketSlice.visible.length + ticketSlice.hiddenCount}
                noun="tickets"
                onExpand={expandSection}
              />
            ) : null}
          </Command.Group>
        ) : null}

        {showSessions && sessionSlice.visible.length > 0 ? (
          <Command.Group heading="Sessions" className={MENU_LABEL_CMDK}>
            {sessionSlice.visible.map(({ row: item, match }) => {
              const context = sessionRowContext(item);
              return (
                <Command.Item
                  key={`session:${item.sessionId}`}
                  value={match.value}
                  keywords={match.keywords}
                  onSelect={() => {
                    useProjectsStore.getState().select(item.projectId);
                    if (item.destination === "detail") {
                      // A closed terminal opens its own saved record and
                      // navigates NOWHERE else (VC-290): its tab is gone, and
                      // the ticket workspace or Home it used to fall through to
                      // is a different Session's surface.
                      useUiStore.getState().openSessionDetail(item.projectId, item.sessionId);
                    } else if (item.sessionKind === "chat") {
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
                  <span
                    className="flex min-w-0 flex-1 flex-col"
                    // The whole mark for a Session another Session started, on
                    // a node this row already had (VC-131).
                    title={sessionProvenanceHoverLine(item.provenance) ?? undefined}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-ui font-medium">{item.title}</span>
                      {/* After the title rather than before it: this row's
                          leading slot is the kind glyph, and a bolt wedged
                          between that glyph and the title would break the
                          column every other palette row is scanned down. */}
                      <SessionProvenanceMark provenance={item.provenance} rowTitle={item.title} />
                    </span>
                    <span className="truncate text-label text-muted-foreground">{context}</span>
                  </span>
                  <span className="shrink-0 text-label text-muted-foreground">
                    {item.destination === "detail" ? "Open details" : "Open session"}
                  </span>
                </Command.Item>
              );
            })}
            {sessionSlice.hiddenCount > 0 ? (
              <ShowAllRow
                sectionId="sessions"
                total={sessionSlice.visible.length + sessionSlice.hiddenCount}
                noun="sessions"
                onExpand={expandSection}
              />
            ) : null}
          </Command.Group>
        ) : null}

        {showAutomations && (automationSlice.visible.length > 0 || selectedProjectId !== null) ? (
          <Command.Group heading="Automations" className={MENU_LABEL_CMDK}>
            {automationSlice.visible.map(({ row: item, match }) => (
              <Command.Item
                key={`automation-run:${item.automationId}`}
                value={match.value}
                keywords={match.keywords}
                onSelect={() => {
                  // The palette closes now, but VC-234's universal landing
                  // rule keeps the current workspace in place. Success toasts
                  // with the fresh Session as an explicit action.
                  void runAutomationOnTicket({
                    target: { kind: "automation", automationId: item.automationId },
                    automationName: item.name,
                    ticketId: item.ticketId,
                    ticketDisplayId: item.ticketDisplayId,
                    // Run by name, on the Automation's own Runtime. The
                    // per-invocation override lives where a person has already
                    // stopped to choose (VC-112), not on a name typed in flight.
                    modelOverride: null,
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
            {automationSlice.hiddenCount > 0 ? (
              <ShowAllRow
                sectionId="automations"
                total={automationSlice.visible.length + automationSlice.hiddenCount}
                noun="automations"
                onExpand={expandSection}
              />
            ) : null}
            {selectedProjectId !== null ? (
              <Command.Item
                key="automations-page"
                value="automations new automation create automation"
                keywords={["new", "create", "automation", "edit", "page"]}
                onSelect={() => {
                  // NAVIGATION, not authoring. The palette runs Automations
                  // (above) and goes to the page that authors them; it does
                  // not open the form itself, because only that page authors
                  // (VC-112) and a create summoned from anywhere is a second
                  // authoring surface wearing a palette row.
                  useWorkspaceStore.getState().setNav(selectedProjectId, "automations");
                  finishNavigation();
                }}
                className={PALETTE_ROW}
              >
                <LightningIcon aria-hidden className={PALETTE_ROW_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">Automations</span>
                  <span className="truncate text-label text-muted-foreground">
                    New, edit, duplicate
                  </span>
                </span>
              </Command.Item>
            ) : null}
          </Command.Group>
        ) : null}

        {scope === null && editorCommands.length > 0 ? (
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
      </Command.List>
      <div className="flex h-9 items-center justify-end gap-4 border-t border-border px-4 text-label text-muted-foreground">
        <span>@ filter</span>
        <span>↑↓ navigate</span>
        <span>↵ open</span>
      </div>
    </PaletteDialog>
  );
}
