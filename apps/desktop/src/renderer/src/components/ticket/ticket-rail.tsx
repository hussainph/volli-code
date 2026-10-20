/**
 * Ticket detail right rail — the Calm Stack (decision #46; designed in the
 * ticket-right-sidebar lab scratch, since retired — this file reproduces its
 * `SidebarPanel` + `ActiveLabelTabs` + `NowPanel` and is now the design of
 * record; the Now page's second shape was settled in
 * `lab/scratches/rail-now-compare.tsx`, since retired with it — the shipped
 * pair is mounted whole in `lab/scratches/rail-whole.tsx`).
 *
 * The panel owns its own header: one centred pill of four pages — Now, Diffs,
 * Files, Search — floating above whichever page is showing. The icon strip
 * that used to run down the rail's outer edge is gone, and so is Properties as
 * a page of its own: it folds inline into Now.
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
 * NOW IS ORDERED BY WHERE ATTENTION GOES, most often first (VC-406, second
 * pass). The first pass ordered it by kind — what the Ticket IS, what can be
 * RUN, what is HAPPENING — and that put a rarely-pressed list of Automations
 * above the roster of live Sessions, which is the one block on the page a
 * person consults every few minutes and the most direct way to the right
 * chat. Taxonomy beat frequency, and the comparison scratch drew the cost.
 * Three sections, and every one of them the same object (an eyebrow over
 * `ListRow`s):
 *
 *   1. Properties — status, priority, labels, as rows. The header of the thing
 *      everything below is about, and the smallest block on the page.
 *   2. Sessions — the working set, and the door to the right chat, with the
 *      record of ended Sessions FOLDED under it behind the eyebrow's own label.
 *      One roster read at two ages is one section; the fold is what lets the
 *      live rows sit at the top without the record standing between them and
 *      the rest of the page.
 *   3. Automations — what can be started here, height-capped. Below the roster
 *      because it is pressed far less often than the roster is read; still on
 *      the page because a Run is how a row appears in that roster.
 *
 * UNDER THE SCROLLER, TWO ROWS. The worktree (`TicketRepositorySummary`) and
 * the cost (`TicketUsageRailFooter`) are the two things on the rail that are
 * glanced at rather than worked in, and each is one pinned row whose body
 * folds open ABOVE it — the row never moves under the pointer. The worktree
 * row stands under EVERY page: it is true of the whole Ticket, and the first
 * pass, which moved the repository card to Diffs, left the resting page with
 * no git signal at all. Cost is Now's alone.
 *
 * The page stacks with ONE `gap` and no block pays its own top padding: an
 * absent block then leaves no hole behind it, and a block cannot drift from
 * its neighbours by carrying a different inset than theirs. Nothing on Now is
 * a button any more — every act is a row that opens or runs the thing it
 * names, and the two footer rows fold.
 *
 * Nothing in here collapses the rail. That is deliberate, not an omission — a
 * panel cannot reopen itself, so the collapse control lives outside it, in the
 * tab strip's corner.
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
import { TicketRepositorySummary } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketUsageRailFooter } from "@renderer/components/usage/usage-rail";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  resolveRailMode,
  selectRailMode,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { RAIL_NARROW_MAX_WIDTH, useUiStore } from "@renderer/stores/ui";
import { LocalOnly } from "@renderer/components/hosts/local-only";

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
    //
    // `data-volli-rail` marks the whole column, including the pages handed in
    // from the host and the footer rows under them, as the scope globals.css
    // hides scrollbars in — which is why it sits on this root rather than on
    // each scroller: the page that overflows is not always one this file owns.
    <div
      className="group/rail flex min-h-0 min-w-0 flex-1 flex-col"
      data-narrow={narrow ? "true" : "false"}
      data-volli-rail="ticket"
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
              {/* What this Ticket IS: status, priority, labels — as rows. */}
              <TicketProperties projectId={projectId} ticket={ticket} />
              {/* The working set, with the record folded under it. The block
                  a person reads most often, so it sits nearest the top. */}
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
              {/* What can be STARTED on this Ticket (VC-129), height-capped so
                  a project with thirty Automations costs the same vertical
                  space as one with three. Its Runs are Sessions, and they are
                  listed where Sessions are — in the roster above, wearing the
                  bolt — not under this block. The rail never authors: it runs,
                  and links to the page. */}
              <LocalOnly projectId={projectId} fallback={null}>
                <TicketAutomationsPanel projectId={projectId} ticket={ticket} />
              </LocalOnly>
            </div>
            {/* What this Ticket cost (VC-87), pinned under the scroller and
                folding open above its row. Absent — not empty — when cost is
                turned off or nothing was metered. */}
            <LocalOnly projectId={projectId} fallback={null}>
              <TicketUsageRailFooter ticketId={ticket.id} />
            </LocalOnly>
          </>
        ) : null}
        {/* This Mac's worktree, files and search: a remote project's are on
            its host (VC-711), and none of them is asked about its ticket. */}
        {mode === "changes" ? <LocalOnly projectId={projectId}>{changesContent}</LocalOnly> : null}
        {mode === "files" ? <LocalOnly projectId={projectId}>{filesContent}</LocalOnly> : null}
        {mode === "search" ? <LocalOnly projectId={projectId}>{searchContent}</LocalOnly> : null}
      </section>
      {/* The worktree, under EVERY page (VC-406): one pinned row — the branch
          and the one fact about it that the reader would act on next — with
          the repository card's body folded above it. Outside the tabpanel
          because it is not a page's content: it is true of the Ticket
          whichever page is up. Drawn on a ticket with no worktree too — that
          is the only window in which the worktree/main-checkout scoping is
          still changeable, and its control lives in this row's identity
          popover (VC-16). */}
      <LocalOnly projectId={projectId} fallback={null}>
        <TicketRepositorySummary projectId={projectId} ticket={ticket} />
      </LocalOnly>
    </div>
  );
}
