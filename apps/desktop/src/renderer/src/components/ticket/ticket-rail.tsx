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
 * WHAT THE RAIL IS FOR, AND WHAT IT IS NOT (VC-406). The rail is the Ticket's
 * hub: everything on it is true of the whole Ticket or its worktree, and
 * nothing on it is true of one chat in particular. The chat's own holdings —
 * its browser tabs, its subagents, its plan, its background shells — belong
 * to the Activity Island above that chat's composer
 * (`chat/activity-island-ui.tsx`), which is why the roster here lists no
 * Subagent Session and the island lists no sibling chat. The two surfaces
 * split one question by scope: the island answers "what is THIS Session
 * holding", the rail answers "what is happening on this Ticket". A block that
 * would be true of only the front chat is a block in the wrong place.
 *
 * Now is the resting page, and it reads in three tiers — what this Ticket IS,
 * what can be RUN on it, what is HAPPENING on it — with the money last:
 *
 *   1. Properties — what the ticket is; three editable facts as pills, and
 *      the smallest block on the page. It opens because it is the header of
 *      the thing everything below is about, and because status is the field
 *      that decides what the block under it offers.
 *   2. Automations — what can be started here, as a height-capped list.
 *      Between the facts and the roster because a Run is how a row appears in
 *      that roster.
 *   3. Sessions — the working set, and the door to the right chat.
 *   4. History — the record. It only grows, so it closes the scroller.
 *   5. Usage — what it cost, PINNED under the scroller as a footer rather
 *      than stacked in it. Cost is glanced at, never worked in: a block that
 *      scrolls away is one you hunt for, and one that costs a row of the
 *      resting view is one you never have to.
 *
 * The worktree is NOT here (VC-406). The repository card moved to the Diffs
 * page, where the changes it commits are on screen underneath it — see
 * `ticket-repository-summary.tsx` for why the act belongs beside its subject.
 *
 * The page stacks with ONE `gap` and no block pays its own top padding: an
 * absent block (History on a new Ticket) then leaves no hole behind it, and a
 * block cannot drift from its neighbours by carrying a different inset than
 * theirs. Two object kinds carry the page — a section (an eyebrow row over
 * list rows) and the framed card — and every act on it wears one control
 * recipe (`RAIL_CONTROL`), so "is this a button" is answered by the drawing.
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
import { TicketUsageRailFooter } from "@renderer/components/usage/usage-rail";
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
          // The scroller and its footer. Only the first scrolls: the page's
          // blocks stack in it, and what is pinned under it stays readable at
          // any scroll position.
          <>
            {/* `pb-8` here rather than on the last block: the scratch hangs it
                off its session list, but that list is the one block this file
                does not own, so the page keeps its own floor. */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-8 [scroll-padding-bottom:2rem]">
              {/* What this Ticket IS: status, priority, labels. First because
                  the block under it offers what THIS column arms. */}
              <TicketProperties projectId={projectId} ticket={ticket} />
              {/* What can be STARTED on this Ticket (VC-129), height-capped so
                  a project with thirty Automations cannot push the roster off
                  the page. Its Runs are Sessions, and they are listed where
                  Sessions are — in the roster below, wearing the bolt — not
                  under this block. The rail never authors: it runs, and links
                  to the page. */}
              <TicketAutomationsPanel projectId={projectId} ticket={ticket} />
              {/* The working set and, under it, the record. One component owns
                  both — see its comment for why. */}
              <TicketSessionsPanel
                projectId={projectId}
                ticketId={ticket.id}
                creating={creating}
                onNewSession={onNewSession}
                onNewChat={onNewChat}
                onNewBrowser={onNewBrowser}
                onActivateSession={onActivateSession}
                onActivateChat={onActivateChat}
              />
            </div>
            {/* What this Ticket cost (VC-87), pinned under the scroller.
                Absent — not empty — when cost is turned off or nothing was
                metered, and then the page simply ends at its scroller. */}
            <TicketUsageRailFooter ticketId={ticket.id} />
          </>
        ) : null}
        {mode === "changes" ? changesContent : null}
        {mode === "files" ? filesContent : null}
        {mode === "search" ? searchContent : null}
      </section>
    </div>
  );
}
