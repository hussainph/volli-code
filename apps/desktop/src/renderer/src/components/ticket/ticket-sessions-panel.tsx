import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/csr/EnvelopeSimple";
import { EnvelopeSimpleOpenIcon } from "@phosphor-icons/react/dist/csr/EnvelopeSimpleOpen";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import {
  errorMessage,
  sessionProvenanceOf,
  type SessionListingRow,
  type SessionProvenance,
  type SessionRecord,
} from "@volli/shared";
import { sessionSourceHarness } from "@volli/session-presentation";

import { renameChatSession } from "@renderer/chat/rename";
import { PeekConversation } from "@renderer/components/session-peek/peek-conversation";
import {
  createSidebarPeekPorts,
  sessionGlyphName,
  UnreadDot,
  usePeekHold,
} from "@renderer/components/session-peek/sidebar-peek";
import {
  useSessionPeek,
  type SessionPeekRow,
} from "@renderer/components/session-peek/use-session-peek";
import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import {
  sessionRowVendor,
  type SessionRowVendor,
} from "@renderer/components/sidebar/session-band-row";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import { resumeTicketSession } from "@renderer/components/sessions/session-create";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { Input } from "@renderer/components/ui/input";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { SessionProvenanceMark } from "@renderer/components/sessions/session-provenance-mark";
import {
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldHeadingRow,
  RailHeadingReadStatus,
  RailReadFaultBody,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  railReadCanClaimEmpty,
  railReadFeedback,
} from "@renderer/components/ticket/rail-read-feedback";
import { useRemoteSessionsUnavailable } from "@renderer/stores/remote-session-availability";
import { SESSION_ROSTER_FILTER_THRESHOLD as SESSION_FILTER_THRESHOLD } from "@renderer/components/ticket/session-history";
import {
  buildTicketChatSessionRows,
  buildTicketSessionRows,
  canResumeSession,
  filterChatSessionHistory,
  filterSessionHistory,
  groupChatSessionRows,
  groupSessionRows,
  mergeSessionRailRows,
  nextSessionRailAgeChangeAt,
  nextTicketSessionStatusChangeAt,
  orderSessionRailRowsByHold,
  sessionRailOrderMembers,
  sessionRailRowActivityAt,
  sessionRailRowDotState,
  sessionRailRowId,
  sessionRailRowSessionId,
  sessionRailRowStampAt,
  ticketOutputStamps,
  ticketSessionProvenance,
  ticketSessionUnreadIds,
  type SessionRailRow,
  type TicketSessionStatus,
} from "@renderer/components/ticket/session-history";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { delayUntil } from "@renderer/lib/boundary-timer";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useProjectsStore } from "@renderer/stores/projects";
import { ticketRailOrderKey, useHeldSessionOrder } from "@renderer/stores/session-order";
import { launchAdapter, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import {
  ticketSessionListingStateOf,
  useTicketSessionRecordsStore,
} from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";
import { renameTerminalSession } from "@renderer/terminal/session-lifecycle";

/** Stable empty list so the rows selector never returns a fresh reference
 *  (and re-renders the panel) on unrelated store updates while the cache is cold. */
const NO_ROWS: SessionListingRow[] = [];

function sessionStatusLabel(status: TicketSessionStatus): string {
  return status === "setup" ? "Setup" : SESSION_ACTIVITY_LABEL[status];
}

/** The rail draws no ticket folders — every row here is a Session of one ticket. */
const NO_FOLDERS: ReadonlyMap<string, readonly string[]> = new Map();

/** What a row's activation needs to know about the surface it sits on. */
interface RailActivationScope {
  projectId: string;
  ticketId: string;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
  setActivePane(ownerId: string, tabId: string, paneId: string): void;
}

/**
 * What one rail row OPENS, or `null` where there is nothing to open.
 *
 * One definition, because two surfaces now take it: the row's own click, and
 * the peek card's `Open session` button (VC-30). A card that opened a Session
 * by a second route is how the two come to disagree about which pane a split's
 * row belongs to.
 */
function railRowActivation(entry: SessionRailRow, scope: RailActivationScope): (() => void) | null {
  if (entry.kind === "chat") {
    // Always activatable, unlike a terminal row — a chat Session is durable, so
    // one whose attachment has closed still opens onto its own history, and
    // reattaching is the Retry the plane offers.
    const { sessionId } = entry.row.record;
    return () => scope.onActivateChat(sessionId);
  }
  const { record, tabId } = entry.row;
  // Exited-but-open panes live in History but still activate their tab and
  // exact split pane. A CLOSED record has no tab to activate, and it is no
  // longer inert either (VC-290): it opens its own saved record — the same
  // destination the sidebar's Previous row and ⌘K now reach.
  if (tabId === undefined) {
    return record.endedAt === null
      ? null
      : () => {
          useUiStore.getState().openSessionDetail(scope.projectId, record.id);
        };
  }
  return () => {
    scope.onActivateSession(tabId);
    scope.setActivePane(scope.ticketId, tabId, record.id);
  };
}

/**
 * What a ROW's own click does: take the same door the card's `Open session`
 * takes (`ports.openSession`), so opening from the list reads the Session
 * exactly as opening from the card does (plan §3.4, D6). The rail used to read
 * on the card's press and not on the row's, so clicking a row left the dot on
 * a Session that was now in front of the person.
 *
 * {@link railRowActivation} still decides whether the row is a door at all — a
 * live-but-closed terminal record is not one — and remains the single
 * definition of where that door leads.
 */
function railRowOpen(
  entry: SessionRailRow,
  scope: RailActivationScope,
  openRow: (rowId: string) => void,
): (() => void) | null {
  if (railRowActivation(entry, scope) === null) return null;
  const rowId = sessionRailRowId(entry);
  return () => openRow(rowId);
}

/**
 * WHAT READS A SESSION lives in `session-peek/sidebar-peek.ts` now, not here:
 * opening a row, a delivered answer or message, and viewing the conversation
 * all read (plan §3.4, D6), and both sidebars get that from one module rather
 * than from two copies that had already drifted. This file answers only the
 * four questions that are genuinely the rail's — what a row opens, where the
 * conversation overlay lives, which ticket's store holds the receipts, and
 * that there is no ticket to navigate to.
 */

/** The earlier of two boundary instants, either of which may be "never". */
function soonest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

/**
 * The one block: the live rows, and the record folded under them. One shape,
 * one inset, no seam. No top padding of its own: the Now page stacks its
 * blocks with one `gap`, so a block that is absent leaves no gap behind it
 * (VC-406).
 */
const SECTION = cn("flex flex-col gap-1", RAIL_PANEL_INSET);

/**
 * The inline empty, inside the dashed frame this rail uses for a section that
 * has rows on other days. Written once — the two sites that take it (no current
 * sessions, no history matches) were two copies of the same string.
 */
const SESSION_SECTION_EMPTY = cn(
  "rounded-lg border border-dashed border-sidebar-border",
  EMPTY_INLINE,
);

/**
 * Every row's QUIET SECOND LINE: one tone dot, the state, and when (VC-406).
 *
 * It was the row's right EDGE, competing with the title for one line's width —
 * so at the rail's 300px a real Session title read `Investigate the session
 * li…` beside `Waiting for you`, and the two facts the row exists to carry
 * each cost the other. The title has the whole line now; the state has its own
 * underneath at `text-label` (11/16), inside `ListRow`'s 52px `two-line`
 * density. A live row says what it is doing and a past one says when it
 * stopped, in the same two-part shape either way — which is what lets the
 * column be read down rather than row by row.
 *
 * The dot takes the STATE, not a colour. This panel used to hold its own
 * status→tone map and the tab strip held a second one that disagreed with it
 * about the same Session — `ui/status-dot.tsx` is now the only place either
 * question is answered. Terminal history is `exited`; a stopped chat keeps
 * `stopped` so the deliberate end does not disappear into generic history.
 */
function RowStatus({ state, children }: { state: StatusDotState; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
      <StatusDot state={state} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * One session, flat: the Session's mark, its title, and one quiet line — no
 * frame. The frame and the second metadata line the rail used to draw made
 * three sessions look like three cards to inspect; the roster's job is to be
 * read down in a glance, so the border only appears under the pointer
 * (the retired ticket-right-sidebar lab scratch: `SessionRows`).
 *
 * THE LEADING SLOT IS THE MARK (VC-30, D4). It was `ChatCircle`/`TerminalWindow`
 * plus a status dot on the second line; it is now one `SessionGlyph` — the
 * vendor's own logo with the state as a badge on its corner — which is what
 * every Session row in both sidebars draws. The kind is still stated: the
 * glyph falls back to the same two shipped icons when there is no logo, and
 * the accessible name names the kind and the state together.
 *
 * WHAT THE SECOND LINE SAYS DEPENDS ON THE HALF IT IS IN (D5). A live row's
 * line is the AGE alone — the mark carries the state, and the ticket is the
 * page this rail sits on — while a record row keeps its state word, because
 * there the whole content of a row is "how it ended and when".
 *
 * NO NATIVE `title` (D1). The untruncated title and the provenance line the
 * attribute used to carry are what the peek card says, and a browser tooltip
 * would open on top of that card at nearly the same instant.
 *
 * A past terminal row is inert for activation (its pane is gone; Resume is in
 * the menu), so it draws as a div and never lights up under the pointer — which
 * is the honest way to say "not a target" without dimming a title a person may
 * still want to read.
 */
function SessionRow({
  rowId,
  glyph,
  title,
  secondary,
  unread,
  provenance,
  editing,
  drag,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResume,
  onToggleRead,
}: {
  /** The peek's and the held order's address for this row (`chat:` / `session:`). */
  rowId: string;
  /** The Session's mark — `SessionGlyph`, built by the list from the row's state. */
  glyph: React.ReactNode;
  /** The live tab title when open (so optimistic renames show), else the durable record title. */
  title: string;
  /** The quiet line under the title: the age, and in the record half the state too. */
  secondary: React.ReactNode;
  /** Whether this Session has work nobody has seen (VC-108) — dot and heavier title. */
  unread: boolean;
  /**
   * Who started this Session (VC-131). The rail is a listing like any other, so
   * it draws the same mark the sidebar's bands do, from the same component —
   * the rule is that a Run's Session is distinguishable everywhere a Session
   * appears, and a rail with its own idea of that would be the second place to
   * fix when the mark changes.
   */
  provenance: SessionProvenance;
  editing: boolean;
  /**
   * What this row would open if it were dropped on a pane (VC-202 §4), or
   * `null` for a row that is not a door — which is the same condition that
   * makes `onActivate` null, said for the other gesture.
   */
  drag: SplitDragPayload | null;
  /** `null` where there is nothing to open — a closed terminal record's pane is gone. */
  onActivate: (() => void) | null;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
  /** Present only for resumable history rows (interrupt/resume, issue #78). */
  onResume?(): void;
  /**
   * Marks the Session read or unread. `null` on a terminal companion, which has
   * no turns to leave unseen (plan §3.5, amendment A4/Q2).
   */
  onToggleRead: (() => void) | null;
}) {
  const row = (
    <ListRow
      // Two lines, 52px: the title owns one and the state owns the other. While
      // a row is being renamed it drops to the one-line density — the field
      // fills the name's line, and a quiet status under an input being typed
      // into is a second thing moving in a row that is already changing.
      density={editing ? "row" : "two-line"}
      // While editing the row is inert: an input inside the activating button
      // would both nest an interactive control and open the Session on every
      // click into the field.
      onActivate={editing ? null : onActivate}
      // …and a row being renamed does not drag either: the pointer is there to
      // select text in the field under it.
      {...splitDragSourceProps(editing ? null : drag)}
      leading={glyph}
      primary={
        editing ? (
          <InlineRename
            value={title}
            ariaLabel={`Rename ${title}`}
            className="min-w-0 flex-1"
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span
            // `gap-1` is the ladder's icon↔label rung (docs/DESIGN.md), and the
            // same gap the mark sits at in the sidebar's rows.
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            {/* Left of the title rather than after it: this row's right edge is
                the status column, and a mark that drifted between the title and
                that column depending on title length would stop being scannable
                down the list. */}
            <SessionProvenanceMark provenance={provenance} />
            <span
              // Unread outranks read by WEIGHT alone; the colour stays the
              // row's own, so the dot is the only new ink on the line.
              className={cn(
                "min-w-0 flex-1 truncate text-ui",
                unread ? "font-semibold" : "font-medium",
              )}
              onDoubleClick={onStartRename}
            >
              {title}
            </span>
          </span>
        )
      }
      secondary={editing ? undefined : secondary}
      trailing={unread && !editing ? <UnreadDot /> : undefined}
    />
  );

  return (
    // The peek finds rows by these attributes rather than by a wrapper
    // (`session-peek/use-session-peek.tsx`): the `<li>` is the Session, and the
    // row inside it stays the shipped row — drag source, rename field, menu.
    <li data-peek-row={rowId} data-peek-surface="rail" data-unread={unread ? "" : undefined}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          {onResume !== undefined ? (
            <ContextMenuItem icon={ArrowClockwiseIcon} onSelect={onResume}>
              Resume
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem icon={PencilSimpleIcon} onSelect={onStartRename}>
            Rename
          </ContextMenuItem>
          {onToggleRead === null ? null : (
            <ContextMenuItem
              icon={unread ? EnvelopeSimpleOpenIcon : EnvelopeSimpleIcon}
              onSelect={onToggleRead}
            >
              {unread ? "Mark as read" : "Mark as unread"}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Two rows' worth of the roster's own geometry, while the baseline read is in
 * flight: the list's gap, a `ListRow`'s inset and height, a title at the left
 * and the status phrase at the right. No words — the rows that replace this
 * carry the words.
 */
function SessionListSkeleton() {
  return (
    <div
      className="flex flex-col gap-1"
      {...loadingRegionProps("sessions")}
      data-testid="ticket-sessions-loading"
    >
      {(["w-3/5", "w-2/5"] as const).map((width) => (
        <ListRowSkeleton key={width} mark primaryWidth={width} trailingWidth="w-12" />
      ))}
    </div>
  );
}

/**
 * What a chat row's mark is NAMED after: the provider whose logo it draws, or
 * the kind where the Session records no model. `ModelSelection` carries no
 * display label — the readable provider names live in the Model Access
 * catalog, which a roster row has no reason to subscribe to.
 */
function chatProviderLabel(entry: SessionRailRow & { kind: "chat" }): string {
  return entry.row.record.model?.providerId ?? "Chat";
}

/**
 * A rail row's vendor. A chat is drawn with its model's provider; a companion
 * by the shipped source rule (`sessionSourceHarness`) that the left band reads
 * too — a bare shell names no harness and reads `Shell`. Never
 * `effectiveHarnessId` alone: its fallback is the DEFAULT harness, which put
 * Claude Code's name and logo on a plain terminal.
 */
function railRowVendor(entry: SessionRailRow): SessionRowVendor {
  if (entry.kind === "chat") {
    return {
      providerId: entry.row.record.model?.providerId ?? null,
      providerLabel: chatProviderLabel(entry),
    };
  }
  const record = entry.row.record;
  return sessionRowVendor({
    kind: "terminal",
    harnessId: sessionSourceHarness({ kind: "terminal", record }),
    source: record.launchKind === "shell" ? "Shell" : "Terminal",
  });
}

/**
 * The mark for one rail row: the vendor's logo where the Session names one
 * (a chat's model provider, a companion's harness vendor — `harnessVendorId`),
 * the shipped kind glyph where it does not, and the row's own state as the
 * badge. The state is `sessionRailRowDotState`'s answer, never re-derived here.
 */
function rowGlyph(entry: SessionRailRow, status: TicketSessionStatus): React.ReactElement {
  const vendor = railRowVendor(entry);
  return (
    <SessionGlyph
      providerId={vendor.providerId}
      providerLabel={vendor.providerLabel}
      state={sessionRailRowDotState(entry)}
      kind={entry.kind}
      fallback={vendor.fallback}
      // The row no longer prints the state word in its live half, so the mark's
      // name is where both facts are said — through the one naming rule both
      // sidebars share. Named from the row's STATUS, not the badge's state: an
      // ended Session wears the resting badge but is named for how it ended,
      // which is also the word the record fold prints under it.
      name={sessionGlyphName(vendor.providerLabel, status)}
    />
  );
}

function SessionList({
  rows,
  variant,
  provenance,
  unread,
  now,
  lastOutputAt,
  projectId,
  ticketId,
  editingId,
  setEditingId,
  setActivePane,
  onActivateSession,
  onActivateChat,
  onCommitRename,
  onCommitChatRename,
  onResumeSession,
  onToggleRead,
  onOpenRow,
}: {
  rows: readonly SessionRailRow[];
  /**
   * Which age a row's quiet line dates itself from: a current row says when the
   * Session last did anything, a record row says when it stopped.
   */
  variant: "current" | "history";
  /** Sparse, keyed by Session id — a miss is the resting case (VC-131). */
  provenance: Readonly<Record<string, SessionProvenance>>;
  /** The Sessions with work nobody has seen, by Session id (VC-30). */
  unread: ReadonlySet<string>;
  /** The clock both variants' relative stamps are read against. */
  now: number;
  /**
   * Last-output stamps, narrowed to this ticket's own terminal records
   * (`ticketOutputStamps`). A LIVE terminal has no ending to date itself from,
   * so its age is the last line it printed.
   */
  lastOutputAt: Readonly<Record<string, number>>;
  /** Half of a drag payload's scope; the ticket below is the other half. */
  projectId: string;
  ticketId: string;
  editingId: string | null;
  setEditingId(sessionId: string | null): void;
  setActivePane(ownerId: string, tabId: string, paneId: string): void;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
  onCommitRename(record: SessionRecord, isRoot: boolean, next: string): void;
  onCommitChatRename(sessionId: string, next: string): void;
  onResumeSession(record: SessionRecord): void;
  /** Marks one chat Session read or unread — the row's menu and `U` (D6). */
  onToggleRead(sessionId: string, next: boolean): void;
  /** The one door into a Session: the peek's `openSession`, which also reads it. */
  onOpenRow(rowId: string): void;
}) {
  const scope = { projectId, ticketId, onActivateSession, onActivateChat, setActivePane };
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((entry) => {
        if (entry.kind === "chat") {
          const { record, title } = entry.row;
          const { sessionId } = record;
          const rowUnread = unread.has(sessionId);
          return (
            <SessionRow
              key={sessionId}
              rowId={sessionRailRowId(entry)}
              glyph={rowGlyph(entry, record.activity)}
              unread={rowUnread}
              onToggleRead={() => onToggleRead(sessionId, !rowUnread)}
              title={title}
              provenance={sessionProvenanceOf(provenance, sessionId)}
              // A chat Session's activity is the same vocabulary a terminal
              // row's status is (`ChatSessionRecord.activity` is a subset of
              // `SessionActivityState`), so the two kinds say their state in
              // one vocabulary rather than repeating source metadata. Every
              // row carries its age beside that state now (VC-406) — a live
              // row dating itself from when the Session last did anything,
              // a record row from when it stopped.
              secondary={
                variant === "current" ? (
                  // The AGE alone (VC-30, D5): the mark says what it is doing,
                  // and a line repeating it is noise at a glance.
                  relativeTime(sessionRailRowActivityAt(entry, lastOutputAt), now)
                ) : record.activity === "stopped" || record.activity === "interrupted" ? (
                  // VC-324: `interrupted` is durable, so a History row keeps
                  // saying the last turn died after a relaunch exactly as long
                  // as a `stopped` one keeps saying it was ended on purpose —
                  // collapsing either into generic history is the drift.
                  <RowStatus state={record.activity}>
                    {sessionStatusLabel(record.activity)} ·{" "}
                    {relativeTime(sessionRailRowStampAt(entry), now)}
                  </RowStatus>
                ) : (
                  <RowStatus state="exited">
                    {relativeTime(sessionRailRowStampAt(entry), now)}
                  </RowStatus>
                )
              }
              editing={editingId === sessionId}
              // A chat Session is durable, so it drags whether or not it has a
              // tab: dropping it adopts it and mints one, exactly as clicking.
              drag={{
                type: "session",
                scope: "ticket",
                projectId,
                ticketId,
                kind: "chat",
                sessionId,
              }}
              onActivate={railRowOpen(entry, scope, onOpenRow)}
              onStartRename={() => setEditingId(sessionId)}
              onCommitRename={(next) => onCommitChatRename(sessionId, next)}
              onCancelRename={() => setEditingId(null)}
            />
          );
        }
        const { record, title, isRoot, tabId, status } = entry.row;
        return (
          <SessionRow
            key={record.id}
            rowId={sessionRailRowId(entry)}
            glyph={rowGlyph(entry, status)}
            // A companion has no turns and no interactions, so nothing about it
            // can go unseen and nothing here offers to mark it (plan §3.5).
            unread={false}
            onToggleRead={null}
            title={title}
            provenance={sessionProvenanceOf(provenance, record.id)}
            secondary={
              variant === "current" ? (
                relativeTime(sessionRailRowActivityAt(entry, lastOutputAt), now)
              ) : (
                <RowStatus state="exited">
                  {relativeTime(sessionRailRowStampAt(entry), now)}
                </RowStatus>
              )
            }
            editing={editingId === record.id}
            // Only an OPEN terminal drags: the tab is what a pane holds, and a
            // closed record has none — the same fact that sends activation to
            // its saved detail below rather than into a pane.
            drag={
              tabId === undefined
                ? null
                : {
                    type: "session",
                    scope: "ticket",
                    projectId,
                    ticketId,
                    kind: "terminal",
                    sessionId: tabId,
                  }
            }
            onActivate={railRowOpen(entry, scope, onOpenRow)}
            onStartRename={() => setEditingId(record.id)}
            onCommitRename={(next) => onCommitRename(record, isRoot, next)}
            onCancelRename={() => setEditingId(null)}
            onResume={
              variant === "history" && canResumeSession({ kind: "terminal", record }, launchAdapter)
                ? () => onResumeSession(record)
                : undefined
            }
          />
        );
      })}
    </ul>
  );
}

/**
 * The Now page's roster: ONE "Sessions" section — the working set (one flat
 * row per live session from the unified store) with the record of the
 * ended/closed durable Sessions FOLDED under it, searchable past 4 entries
 * (VC-406).
 *
 * The record used to be a sibling section, "History", with its own eyebrow and
 * a count badge. Two sections for one roster read at two ages put the block a
 * reader consults most — the live rows — and the block they consult least
 * twenty rows apart, and the page's other blocks had to choose which of the
 * two to sit beside. Here the eyebrow's own LABEL is the fold
 * (`RailFoldHeadingRow`): `SESSIONS ›` with the record away, `SESSIONS ⌄` with
 * it under the live rows, and `+ Chat ▾` still the row's one control at the
 * right. The count of what is folded is in the trigger's accessible name and
 * nowhere on the face — the caret alone says there is more, and an eyebrow
 * holds a label and at most one control (docs/DESIGN.md).
 *
 * THIS IS NOT THE RETIRED DRAWER. History was once a `RailDrawer`: a
 * full-bleed `border-t` across the whole column, an uppercase trigger with a
 * rotating caret, a collapse animation, and the WHOLE block behind it. Nothing
 * here bleeds past the section's inset, the closed state still shows the rows
 * that matter, only the record folds, and the trigger never moves — the
 * record opens under it, so a second press lands where the first did. The
 * motion is the rail's one fold (`rail-panel-parts.tsx`), not this file's.
 *
 * The fold is a GLOBAL preference (`railFolds.sessionsRecord`), not
 * per-ticket: it is how a person reads the rail, and a reader who wants the
 * record open wants it open on the next Ticket too. A roster with no record
 * offers no fold at all — a caret opening onto nothing is a lie about the
 * block.
 *
 * One component still owns both halves: they are two views of ONE read of the
 * durable roster and one pair of clocks. The `children` slot that briefly let
 * the page thread a block between them (VC-406's first pass) is gone — there
 * is nothing between them any more.
 *
 * It sits IN FLOW: the Now page is one scrolling column (ticket-rail.tsx), so
 * this owns no scroller of its own. The durable list
 * (`api.sessions.listForTicket`) is re-read whenever the live set changes so
 * new sessions appear and closed ones fold into the record. Rows rename inline
 * (double-click) or via the right-click menu.
 */
export function TicketSessionsPanel({
  projectId,
  ticketId,
  creating,
  onNewSession,
  onNewChat,
  onNewBrowser,
  onActivateSession,
  onActivateChat,
}: {
  /** Whose project this ticket is — half of a row's drag payload (VC-202 §4). */
  projectId: string;
  ticketId: string;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
  /** Opens a blank Browser Tab in the main strip, in this ticket's scope. */
  onNewBrowser?(): void;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
}) {
  const open = useUiStore((state) => state.railFolds.sessionsRecord);
  const liveTabs = useSessionsStore((state) => state.byOwner[ticketId]?.tabs);
  const parkState = useSessionsStore((state) => state.parkState);
  // The sidebar's session bands read this exact map for their own attention
  // rows; reading it here is what keeps the two surfaces from answering "is the
  // agent blocked on me?" differently at the same instant.
  const harness = useSessionsStore((state) => state.harness);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const worktreePhase = useWorktreeStore((state) => phaseFor(state.phases, ticketId));
  // `creating`/`copying` haven't booted a PTY yet, so there's no session row to
  // chip — they reuse the existing pre-boot "starting" affordance (disables the
  // session-start control the same way an in-flight `starting[ticketId]` create
  // does) rather than inventing a second loading state.
  const effectiveCreating = creating || worktreePhase === "creating" || worktreePhase === "copying";
  // The durable list is a shared cache (stores/ticket-session-records.ts), not
  // local state: the exited-pane resume overlay reads the exact same cache
  // (it can't invent a second `listForTicket` fetch — see session-split-layout.tsx),
  // and SessionsLayer's exit handler refreshes it directly so a just-ended
  // session's `endedAt`/resumability lands here without this panel needing to
  // be the one to notice the exit.
  //
  // VC-383 records the baseline's answer as data in the shared store: an
  // unread/loading roster holds its rows' box, only `loaded` earns the empty
  // sentence, and `failed` replaces either lie with the brief failure line.
  // A component must not infer that lifecycle from whether its row array exists.
  const listing = useTicketSessionRecordsStore((state) => state.byTicket[ticketId]);
  // A host that grants this window no Session features (VC-713): said in its
  // name, in place of the roster's reads, and never as a failure to retry.
  const sessionsUnavailable = useRemoteSessionsUnavailable(projectId);
  const listingState = useTicketSessionRecordsStore((state) =>
    ticketSessionListingStateOf(state, ticketId),
  );
  const listingError = useTicketSessionRecordsStore(
    (state) => state.listingError?.[ticketId] ?? null,
  );
  // Rows survive a failed refresh in the store, so "has this ever landed" is a
  // question about the CACHE rather than about the state word: a refresh that
  // failed leaves last-good rows drawn, with the caveat on the heading.
  const readState = {
    hasData: listing !== undefined,
    pending: listingState === "loading",
    failed: listingState === "failed",
  };
  const feedback = railReadFeedback(readState, "Sessions");
  // "Nothing here" is a claim about what a read RETURNED, so only a landed read
  // may make it — the conflation this gate exists to remove drew the failure
  // line and the empty sentence together.
  const canClaimEmpty = railReadCanClaimEmpty(readState);
  const rows = listing ?? NO_ROWS;
  const records = rows.flatMap((row) => (row.kind === "terminal" ? [row.record] : []));
  const chatSessions = rows.flatMap((row) => (row.kind === "chat" ? [row.record] : []));
  // Read off the listing ROWS, before the panel splits them into two record
  // arrays: unread and provenance both ride the row wrapper (VC-30, VC-131).
  const unread = ticketSessionUnreadIds(rows);
  const provenance = ticketSessionProvenance(rows);
  // The peek card names a drilled ticket by its display id; the rail has one
  // project and reads its prefix from the same store every other surface does.
  const ticketPrefix = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.ticketPrefix ?? "",
  );
  // Narrowed to the stamps THIS ticket's rows can name — see `ticketOutputStamps`.
  const lastOutputAt = useSessionsStore(
    useShallow((state) => ticketOutputStamps({ lastOutputAt: state.lastOutputAt, rows })),
  );
  // The clock the STATUS column is read against, advanced only on the instant a
  // status can change on its own (the working→idle window closing). Between
  // boundaries it is deliberately behind the wall clock, and no row is
  // re-derived for the difference, because no row can move in that gap.
  const [activityNow, setActivityNow] = React.useState(() => Date.now());
  // The clock History's relative stamps are read against — a separate one, for
  // the reason the sidebar keeps two: a roster of week-old rows changes its
  // ages about once a day, and making that share a clock with a live session's
  // ten-second window would wake it every ten seconds forever.
  const [ageNow, setAgeNow] = React.useState(() => Date.now());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  // ONE query over the whole roster (VC-406). It used to live inside the fold
  // and reach only the record, so a reader who typed a title that belonged to a
  // live Session was told the roster held no match for it.
  const [rosterQuery, setRosterQuery] = React.useState("");
  const searching = rosterQuery.trim() !== "";
  // The conversation overlay this rail opens from a card's `View conversation`
  // — the shared one (`session-peek/peek-conversation.tsx`), which the left
  // sidebar mounts too.
  const [conversationId, setConversationId] = React.useState<string | null>(null);

  const tabs = liveTabs ?? [];

  const refresh = React.useCallback(
    () => useTicketSessionRecordsStore.getState().ensure(ticketId),
    [ticketId],
  );
  // `refresh`, not `ensure`: `ensure` no-ops on a ticket whose listing already
  // loaded, so a retry routed through it would do nothing on exactly the
  // surface that offers it.
  const retry = React.useCallback(
    () => void useTicketSessionRecordsStore.getState().refresh(ticketId),
    [ticketId],
  );

  // The BASELINE read, and only that. A window that has just opened has missed
  // every push that came before it, so a ticket's rows are read once and
  // `volli:session-activity` carries the list from there — which is why this no
  // longer re-fires on the set of open panes (`liveSignature`). A split, a
  // create and a close are all durable Session facts the push announces; a
  // refetch on the same trigger would just race the push to say the same
  // thing. `ensure` no-ops on a warm ticket, so a rail page flip or a ticket
  // re-open paints from cache without re-asking main.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Renaming the root pane of a live tab goes through the shared optimistic-
  // persist path (so its tab strip updates too); a non-root live pane or an
  // ended session has no live tab title to keep in sync, so persist directly and
  // reconcile the local list.
  const commitRename = (record: SessionRecord, isRoot: boolean, next: string) => {
    setEditingId(null);
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === record.title) return;
    useTicketSessionRecordsStore.getState().renameLocally(ticketId, record.id, trimmed);
    if (isRoot) {
      renameTerminalSession(record.id, trimmed);
      return;
    }
    window.api.sessions
      .rename({ sessionId: record.id, title: trimmed })
      .then((result) => {
        if (!result.ok) {
          toastError(`Rename failed: ${result.error}`);
          void refresh();
        }
      })
      .catch((error: unknown) => {
        toastError(`Rename failed: ${errorMessage(error)}`);
        void refresh();
      });
  };

  // A chat row's whole rename — optimistic slice, optimistic cached record,
  // persist, toast — lives in `renameChatSession`, since the tab strip renames
  // the same Sessions and the two surfaces must not drift.
  const commitChatRename = (sessionId: string, next: string) => {
    setEditingId(null);
    void renameChatSession(sessionId, next);
  };

  // The shared boot pipeline (session-create.ts) — starting-flag guard, engine
  // pre-create, structured-error toast — same as a fresh terminal create, just with a
  // resume intent instead of a fresh kickoff. Lands as a NEW tab; the ended
  // record's own row stays put in History.
  const handleResume = (record: SessionRecord) => {
    void resumeTicketSession(ticketScope(record.projectId, ticketId), record.id).then(
      (sessionId) => {
        if (sessionId !== null) onActivateSession(sessionId);
      },
    );
  };

  const rowsInput = {
    records,
    tabs,
    lastOutputAt,
    parkState,
    harness,
    settingUp: worktreePhase === "setting-up",
    now: activityNow,
  };
  const terminalRows = buildTicketSessionRows(rowsInput);
  const { current: terminalCurrent, history: terminalHistory } = groupSessionRows(terminalRows);
  // A chat Session's lifecycle is NOT whether its attachment is open (VC-406):
  // a Session is durable and outlives every attachment it has ever had, so
  // closing its tab ends nothing. `isLive` is the record's own answer, and it
  // is what keeps a Session that is BLOCKED on a person out of the fold.
  //
  // Unread is the second fact the split reads (D6): work nobody has seen is
  // never retired for going quiet, so an unread Session stays in the live half
  // whatever its lifecycle says — `groupChatSessionRows` owns both rules.
  const chatRows = buildTicketChatSessionRows(chatSessions);
  const { current: chatCurrent, history: chatHistory } = groupChatSessionRows(chatRows, unread);

  // The live rows in the HELD order (VC-30, D7): whatever asks for a person is
  // lifted on the event that made it ask, and then nothing moves while a person
  // is pointing at this rail or reading a peek. It is the same rule and the same
  // store the left sidebar's bands commit through, under this rail's own key
  // (amendment A2) — so one question landing lifts the Session in both places,
  // and neither surface overwrites the other's membership.
  const liveRows = mergeSessionRailRows(
    filterSessionHistory(terminalCurrent, rosterQuery),
    filterChatSessionHistory(chatCurrent, rosterQuery),
  );
  const heldOrder = useHeldSessionOrder(
    ticketRailOrderKey(ticketId),
    sessionRailOrderMembers(liveRows),
  );
  const current = orderSessionRailRowsByHold(liveRows, heldOrder);
  const history = mergeSessionRailRows(terminalHistory, chatHistory);
  const filteredHistory = mergeSessionRailRows(
    filterSessionHistory(terminalHistory, rosterQuery),
    filterChatSessionHistory(chatHistory, rosterQuery),
  );
  // The WHOLE roster, unfiltered, which is what the filter's own threshold is
  // counted over: the query reaches both halves, so what doing without it costs
  // is the total rather than either half (`HOME_SESSION_FILTER_THRESHOLD` makes
  // the same call one scope up).
  const rosterSize = terminalCurrent.length + chatCurrent.length + history.length;
  const filterable = rosterSize > SESSION_FILTER_THRESHOLD || searching;
  // A query dissolves the fold: its matches in the record are ROWS ON THE PAGE,
  // not rows behind a caret the reader would have to guess was hiding them.
  const foldable = history.length > 0 && !searching;

  /**
   * NOTHING HERE POLLS. Two clocks, each waiting on an instant a pure function
   * named: the status column on the working→idle window closing, History's ages
   * on the soonest stamp that stops reading the way it does now. What they
   * replace is one `setInterval` that woke every second for as long as the
   * ticket had a live session and re-derived every row — the whole roster, both
   * sections, the merge and the sort — to discover, sixty times a minute, that
   * nothing had changed.
   *
   * Both are re-armed on every render from the value they were last given; if a
   * boundary does not move after firing, the dependency does not change and the
   * timer is not re-armed, which is what keeps them from spinning.
   */
  const statusBoundaryAt = nextTicketSessionStatusChangeAt(rowsInput);
  React.useEffect(() => {
    if (statusBoundaryAt === null) return;
    const timer = window.setTimeout(() => setActivityNow(Date.now()), delayUntil(statusBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [statusBoundaryAt]);

  // Over the rows the FILTER leaves on screen, not the whole of History: an age
  // nobody is looking at has no boundary worth waking for. `ageNow` is a
  // dependency as well as an input — a boundary computed against a clock that
  // is deliberately behind can land in the past, and keying the effect on the
  // boundary alone would then recompute the same instant and arm nothing.
  //
  // TWO READINGS, ONE CLOCK (VC-406). Every row carries an age now, and a live
  // row's is measured from when the Session last DID something while a record
  // row's is measured from when it stopped — so the boundary is the sooner of
  // the two, computed each against the stamp its own rows print. One reading
  // over both would arm the timer on an instant half the column is not waiting
  // for.
  const ageBoundaryAt = soonest(
    nextSessionRailAgeChangeAt(current, ageNow, (row) =>
      sessionRailRowActivityAt(row, lastOutputAt),
    ),
    nextSessionRailAgeChangeAt(filteredHistory, ageNow),
  );
  React.useEffect(() => {
    if (ageBoundaryAt === null) return;
    const timer = window.setTimeout(() => setAgeNow(Date.now()), delayUntil(ageBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [ageBoundaryAt, ageNow]);

  /* ------------------------------------------------------------- the peek */

  /** Every drawn row the peek can be asked about, by its `chat:`/`session:` id. */
  const peekRows = new Map<string, SessionPeekRow>();
  /** What each row OPENS — the row's own activation, reused by the card's button. */
  const activations = new Map<string, () => void>();
  const activationScope = {
    projectId,
    ticketId,
    onActivateSession,
    onActivateChat,
    setActivePane,
  };
  for (const entry of [...current, ...filteredHistory]) {
    const rowId = sessionRailRowId(entry);
    const sessionId = sessionRailRowSessionId(entry);
    const chat = entry.kind === "chat";
    const rowVendor = railRowVendor(entry);
    const activate = railRowActivation(entry, activationScope);
    if (activate !== null) activations.set(rowId, activate);
    peekRows.set(rowId, {
      rowId,
      sessionId,
      title: entry.row.title,
      // The rail IS the ticket's page, so the card says nothing about it — the
      // block a nav card draws would be the heading two inches above it.
      ticket: null,
      kind: entry.kind,
      state: sessionRailRowDotState(entry),
      providerId: rowVendor.providerId,
      providerLabel: rowVendor.providerLabel,
      at: sessionRailRowActivityAt(entry, lastOutputAt),
      unread: unread.has(sessionId),
      model: chat ? entry.row.record.model : null,
      provenance: sessionProvenanceOf(provenance, sessionId),
    });
  }

  // The ports are memoized on the ticket alone, so what they reach for has to
  // be a ref rather than a closure over this render's maps: a port rebuilt on
  // every build would re-fire `usePeekContent`'s pull on every build.
  const peekRowsRef = React.useRef(peekRows);
  const activationsRef = React.useRef(activations);
  React.useEffect(() => {
    peekRowsRef.current = peekRows;
    activationsRef.current = activations;
  });

  // The pull, the answer and send paths, and every read the plan lists are the
  // SHARED ones (`session-peek/sidebar-peek.ts`): the left band and this rail
  // used to carry two copies of them, and the copies had drifted. What stays
  // here is only what is genuinely the rail's.
  const ports = React.useMemo(
    () =>
      createSidebarPeekPorts({
        // The row's own activation, so the card's `Open session` and a click on
        // the row are one route into a Session rather than two that can
        // disagree about which pane a split's row belongs to. The read that
        // goes with opening is the shared module's (plan §3.4).
        openRow: (rowId) => activationsRef.current.get(rowId)?.(),
        // The rail is already inside its ticket; there is nowhere else to go.
        openTicket: () => {},
        showConversation: setConversationId,
        setRead: (sessionId, unreadNext) => {
          void useTicketSessionRecordsStore
            .getState()
            .setSessionRead(ticketId, sessionId, unreadNext);
        },
      }),
    [ticketId],
  );

  const peek = useSessionPeek({
    ticketPrefix,
    now: ageNow,
    // Read from THIS build's map, not the ref's: a card on screen must redraw
    // the moment its row's state or unread mark changes.
    rowOf: (rowId) => peekRows.get(rowId),
    // The rail has no ticket folders: every row here is a Session of the one
    // ticket this page is about.
    ticketOf: () => undefined,
    folders: NO_FOLDERS,
    ports,
  });

  // The hold (D7), taken for as long as this surface is being pointed at or
  // shows a card. It is GLOBAL, and it is the shared one (`sidebar-peek.ts`):
  // the left sidebar must not re-order under a person reading a card that
  // opened out of this rail, and the reverse.
  usePeekHold(peek.holding);

  const listProps = {
    projectId,
    now: ageNow,
    lastOutputAt,
    unread,
    onToggleRead: (sessionId: string, next: boolean) => {
      void useTicketSessionRecordsStore.getState().setSessionRead(ticketId, sessionId, next);
    },
    // Read off the listing rows before the panel splits them into two record
    // arrays, which is where the row wrapper carrying it is lost (VC-131).
    provenance,
    ticketId,
    editingId,
    setEditingId,
    setActivePane,
    onActivateSession,
    onActivateChat,
    onCommitRename: commitRename,
    onCommitChatRename: commitChatRename,
    onResumeSession: handleResume,
    // One door into a Session for the row and for the card alike — the shared
    // port, which navigates and then reads (plan §3.4).
    onOpenRow: ports.openSession,
  };

  return (
    <RailFold
      asChild
      open={open && foldable}
      onOpenChange={() => useUiStore.getState().toggleRailFold("sessionsRecord")}
    >
      <section className={SECTION} aria-label="Sessions" data-testid="ticket-sessions">
        {/* The heading is inset by the rows' own `px-2`, not by the section's
            edge: a label that hangs left of the list it names reads as a
            divider between blocks rather than as that list's title. The row is
            `justify-between` and carries the reviewed design's always-present
            "+" at its right (the scratch's `SessionRows` header) — the height
            comes from the control, so there is no reserved dead space when the
            roster is full. The label is the record's fold. */}
        <RailFoldHeadingRow
          label="Sessions"
          open={open}
          foldable={foldable}
          triggerLabel={
            open
              ? "Hide past sessions"
              : `Show ${history.length} past session${history.length === 1 ? "" : "s"}`
          }
          testId="ticket-sessions-fold"
          // The mark rides the eyebrow the block already owns — no reserved
          // strip, and no word beside it: this row's budget is a label and one
          // control, and the third thing is what pushes "+ Chat" off the end of
          // a 240px rail.
          status={
            <RailHeadingReadStatus
              feedback={feedback}
              onRetry={retry}
              testId="ticket-sessions-read-status"
            />
          }
        >
          <NewSessionControl
            projectId={projectId}
            disabled={effectiveCreating}
            placement="rail"
            align="end"
            shortcuts
            onNewChat={onNewChat}
            onNewBrowser={onNewBrowser}
            onNewTerminal={onNewSession}
          />
        </RailFoldHeadingRow>
        {/* ONE field over the WHOLE roster, live rows and record alike — in
            flow, above the rows it narrows, exactly where Home's is. It used to
            live INSIDE the fold and reach only the record, so a reader who
            typed the title of a running Session was told the roster held no
            match for it. */}
        {filterable ? (
          <div className="relative mb-1">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={rosterQuery}
              onChange={(event) => setRosterQuery(event.target.value)}
              aria-label="Find a session"
              placeholder="Find a session…"
              className="h-8 pl-8 text-ui md:text-ui"
            />
          </div>
        ) : null}
        {feedback?.kind === "reading" ? (
          // The baseline read is in flight. The heading and its "+" stay live
          // above — a pending list blocks nothing about starting a Session —
          // and the rows hold their box below.
          <SessionListSkeleton />
        ) : null}
        {/* A refused baseline knows nothing about this Ticket's Sessions. The
            toast carries the bridge detail; this keeps the block from claiming
            the roster is empty when it has never been read, and carries the one
            action that can change that. */}
        {sessionsUnavailable !== null ? (
          <p className={SESSION_SECTION_EMPTY} data-testid="ticket-sessions-unavailable">
            {sessionsUnavailable}
          </p>
        ) : (
          <RailReadFaultBody
            feedback={feedback}
            detail={listingError}
            onRetry={retry}
            testId="ticket-sessions-error"
          />
        )}
        {sessionsUnavailable === null &&
        current.length === 0 &&
        (!searching || filteredHistory.length === 0) &&
        canClaimEmpty ? (
          // Nothing to read, so the block is the sentence alone: the header's
          // own control is 20px above it, and a second copy of the same act
          // inside the empty frame would be the same offer twice in one glance.
          // Gated on a read having LANDED — a refused one has proved nothing.
          <p className={SESSION_SECTION_EMPTY}>
            {searching ? "No matching sessions" : "No active sessions"}
          </p>
        ) : null}
        {/* ONE peek surface over both halves: the handlers go on the block that
            holds the rows, never on a row, so a press is still a drag or a
            click and rows keep their own props (`use-session-peek.tsx`). The
            eyebrow above is deliberately outside it — a caret is a disclosure,
            not a subject (plan Q3, amendment A4). */}
        <div
          className="flex flex-col gap-1"
          data-testid="ticket-sessions-peek"
          {...peek.rowProps("rail")}
          {...peek.scrollProps}
        >
          {current.length > 0 ? (
            <SessionList rows={current} variant="current" {...listProps} />
          ) : null}
          {/* The record. While a query is active it is drawn in flow with the live
              matches above it; otherwise it lives under the eyebrow's fold, which
              Radix mounts only while open (and through the close animation), so a
              folded record costs no rows and no age-clock re-derivation. */}
          {searching ? (
            filteredHistory.length > 0 ? (
              <div className="flex flex-col gap-1 pt-1" data-testid="session-history">
                <SessionList rows={filteredHistory} variant="history" {...listProps} />
              </div>
            ) : null
          ) : foldable ? (
            <RailFoldBody>
              <div className="flex flex-col gap-1 pt-1" data-testid="session-history">
                <SessionList rows={filteredHistory} variant="history" {...listProps} />
              </div>
            </RailFoldBody>
          ) : null}
        </div>
        {peek.card}
        {/* The whole conversation, one press further in than the card. Mounted
            here so closing it leaves this rail exactly as it was. */}
        <PeekConversation sessionId={conversationId} onClose={() => setConversationId(null)} />
      </section>
    </RailFold>
  );
}
