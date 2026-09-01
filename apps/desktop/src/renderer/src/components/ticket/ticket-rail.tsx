/**
 * Ticket detail right rail — the Calm Stack (decision #46; designed in the
 * ticket-right-sidebar lab scratch, since retired — this file reproduces its
 * `SidebarPanel` + `ActiveLabelTabs` + `NowPanel` and is now the design of
 * record).
 *
 * The panel owns its own header: one centred pill of four pages — Now, Diffs,
 * Files, Search — floating above whichever page is showing. The icon strip
 * that used to run down the rail's outer edge is gone, and so is Properties as
 * a page of its own: it folds inline into Now, under the repository card.
 *
 * Now is the resting page and answers the three questions in order: what the
 * worktree is doing (`TicketRepositorySummary`), what the ticket is
 * (`TicketProperties`), and who is working on it (`TicketSessionsPanel`).
 *
 * Nothing in here collapses the rail. That is deliberate, not an omission — a
 * panel cannot reopen itself, so the collapse control lives outside it, in the
 * tab strip's corner (docs/plans/fullscreen-placement.md).
 *
 * Page-content seam for the navigators:
 *   - Pass `filesContent` / `changesContent` to replace the empty placeholders.
 *   - On row select, call the host's open/focus helpers — typically
 *     `useWorkspaceStore.getState().previewTicketFile(projectId, ticketId, relPath)`
 *     (click) / `pinTicketFile` (dblclick) for Files and `openTicketDiff` for
 *     Diffs. Sessions already call `onActivateSession(sessionId)` →
 *     `setTicketActiveTab`.
 *   - Do NOT call those openers from agent/filesystem event handlers.
 */
import * as React from "react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { Ticket } from "@volli/shared";

import { TicketAutomationsPanel } from "@renderer/components/automations/ticket-rail-automations";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketUsageRailBlock } from "@renderer/components/usage/usage-rail";
import { TicketRepositorySummary } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  resolveRailMode,
  selectRailMode,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { RAIL_MIN_WIDTH, useUiStore } from "@renderer/stores/ui";

const MODE_ICONS: Record<TicketRailMode, RailModeTab<TicketRailMode>["icon"]> = {
  now: ChatCircleDotsIcon,
  changes: GitDiffIcon,
  files: FoldersIcon,
  search: MagnifyingGlassIcon,
};

/** This surface's pages, in pill order, as {@link RailModeTabs} takes them. */
function railModeTabs(modes: readonly TicketRailMode[]): RailModeTab<TicketRailMode>[] {
  return modes.map((key) => ({ key, label: TICKET_RAIL_MODE_LABELS[key], icon: MODE_ICONS[key] }));
}

/**
 * Above this width the rail takes the design's roomy 16px edge inset; at or
 * below it, 12px. The scratch offered three fixed widths and drew only its
 * 240px floor narrow, so the boundary sits between the two it tested (240 and
 * 300) — the app's rail resizes continuously and has to answer for 260px too.
 */
const RAIL_NARROW_MAX_WIDTH = (RAIL_MIN_WIDTH + 300) / 2;

export function TicketRail({
  projectId,
  ticket,
  creating,
  onNewSession,
  onNewChat,
  onNewBrowser,
  onActivateSession,
  onActivateChat,
  activeTabId,
  filesContent,
  changesContent,
  searchContent,
}: {
  projectId: string;
  ticket: Ticket;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
  /** Opens a blank Browser Tab in the main strip, in this ticket's scope. */
  onNewBrowser?(): void;
  /** Focus (or open) a session tab in the main strip — deliberate selection only. */
  onActivateSession(sessionId: string): void;
  /** Open (adopting first, if nothing is attached) a chat Session's tab. */
  onActivateChat(sessionId: string): void;
  /**
   * The main strip's active tab. The rail never changes it — it is threaded in
   * so page switches run through {@link selectRailMode} on the live path (see
   * `onSelectMode`), not only in tests.
   */
  activeTabId: string;
  /**
   * The Files navigator. The app always passes it (`TicketDetail`); it stays
   * optional only so a lab scratch studying the rail's CHROME can mount the
   * column without booting a navigator, and an absent one draws nothing rather
   * than a placeholder page that no longer stands in for anything.
   */
  filesContent?: React.ReactNode;
  /** The Diffs navigator — same seam as `filesContent`. */
  changesContent?: React.ReactNode;
  /** The Search page (VC-193, plan §4.7) — the same seam again. */
  searchContent?: React.ReactNode;
}) {
  const storedMode = useUiStore((state) => state.railMode);
  const setRailMode = useUiStore((state) => state.setRailMode);
  const narrow = useUiStore((state) => state.railWidth <= RAIL_NARROW_MAX_WIDTH);
  const chrome = { mode: storedMode, activeTabId };
  const mode = resolveRailMode(chrome);
  const modes = availableRailModes();

  // Decision #46: switching page must not open, close, or retarget a main-view
  // tab. The chrome transition is computed by the pure contract and only its
  // `mode` is committed, so the store has no path by which a tab click could
  // reach the tab strip — and the rule the tests assert is the same code the
  // app runs, rather than a parallel description of it.
  const onSelectMode = React.useCallback(
    (next: TicketRailMode) => {
      setRailMode(selectRailMode({ mode, activeTabId }, next).mode);
    },
    [mode, activeTabId, setRailMode],
  );

  const showChanges = React.useCallback(() => onSelectMode("changes"), [onSelectMode]);

  return (
    // The narrow flag travels ONE way: as a group attribute on the column, read
    // by every block through `RAIL_PANEL_INSET`. Not also as a prop — the two
    // navigators arrive as `changesContent`/`filesContent` from the host, so a
    // prop would have to be threaded through `TicketDetail` to reach them, and
    // a rail whose inset came from two sources is a rail with two answers for
    // the blocks that only read one of them.
    <div
      className="group/rail flex min-h-0 min-w-0 flex-1 flex-col"
      data-narrow={narrow ? "true" : "false"}
      data-testid="ticket-rail"
    >
      <RailModeTabs
        modes={railModeTabs(modes)}
        active={mode}
        label="Ticket rail pages"
        idPrefix="ticket-rail"
        onSelect={onSelectMode}
      />
      <section
        id={`ticket-rail-page-${mode}`}
        role="tabpanel"
        aria-labelledby={`ticket-rail-tab-${mode}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {mode === "now" ? (
          // `pb-8` here rather than on the last block: the scratch hangs it off
          // its session list, but that list is the one block this file does not
          // own, so the page keeps its own floor.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8 [scroll-padding-bottom:2rem]">
            <TicketRepositorySummary
              projectId={projectId}
              ticket={ticket}
              onShowChanges={showChanges}
            />
            <TicketProperties projectId={projectId} ticket={ticket} />
            {/* What this Ticket cost, between the facts about it and the
                Sessions that ran on it (VC-87) — which is where the owner's
                question sits. It owns its own inset and top padding, so an
                absent card (cost turned off, or nothing metered on this Ticket)
                leaves no gap behind it rather than sixteen pixels of dead rail. */}
            <TicketUsageRailBlock ticketId={ticket.id} />
            {/* What can be STARTED on this Ticket, between what it cost and who
                is working on it (VC-129). Above the Sessions roster because it
                is an act and the roster is a record of acts — and because the
                Runs it lists are the doors into the Sessions listed under it.
                The rail never authors: this block runs and links to the page. */}
            <TicketAutomationsPanel projectId={projectId} ticket={ticket} />
            <TicketSessionsPanel
              ticketId={ticket.id}
              creating={creating}
              onNewSession={onNewSession}
              onNewChat={onNewChat}
              onNewBrowser={onNewBrowser}
              onActivateSession={onActivateSession}
              onActivateChat={onActivateChat}
            />
          </div>
        ) : null}
        {mode === "changes" ? changesContent : null}
        {mode === "files" ? filesContent : null}
        {mode === "search" ? searchContent : null}
      </section>
    </div>
  );
}
