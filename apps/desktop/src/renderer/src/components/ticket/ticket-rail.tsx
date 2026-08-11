/**
 * Ticket detail right rail — the Calm Stack (decision #46;
 * lab/scratches/ticket-right-sidebar.tsx is the design of record).
 *
 * The panel owns its own header: one centred pill of three pages — Now, Diffs,
 * Files — floating above whichever page is showing. The vertical icon strip
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
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import type { Ticket } from "@volli/shared";

import { TicketProperties, TicketStamps } from "@renderer/components/ticket/ticket-properties";
import { TicketRepositorySummary } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  resolveRailMode,
  selectRailMode,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

const MODE_ICONS: Record<TicketRailMode, PhosphorIcon> = {
  now: ChatCircleDotsIcon,
  changes: GitDiffIcon,
  files: FoldersIcon,
};

/**
 * The pill's own easing — the scratch animates the selection with a
 * near-critically-damped spring (`bounce: 0.1`), whose settle is
 * indistinguishable from the expo-out curve it already uses for the colour
 * change. Expressed as one curve, the whole header costs no runtime animation
 * library and still honours `prefers-reduced-motion` through Tailwind's
 * `motion-reduce:` variant.
 */
const PILL_EASE = "[transition-timing-function:cubic-bezier(0.23,1,0.32,1)]";

/**
 * The rail's header: a centred tablist where only the selected tab wears its
 * label, so three pages fit a 160px pill at the rail's narrowest width without
 * ever truncating a word. Presentational — page state lives in the UI store.
 *
 * Translucent and blurred rather than opaque: at `top-0` of a column whose
 * pages scroll beneath it, the bar is a floating material, not a strip the
 * layout gives away.
 */
function TicketRailTabs({
  mode,
  modes,
  onSelectMode,
}: {
  mode: TicketRailMode;
  /** Which pages this surface offers — see `availableRailModes`. */
  modes: readonly TicketRailMode[];
  onSelectMode(mode: TicketRailMode): void;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? modes.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length;
    const nextMode = modes[next];
    if (nextMode === undefined) return;
    onSelectMode(nextMode);
    refs.current[next]?.focus();
  }

  return (
    <div className="sticky top-0 z-20 shrink-0 bg-sidebar/80 px-4 py-3 backdrop-blur-xl">
      <div
        role="tablist"
        aria-label="Ticket rail pages"
        className="mx-auto flex h-10 w-40 items-center gap-0.5 rounded-full border border-sidebar-border bg-background/75 p-1 shadow-xs"
      >
        {modes.map((key, index) => {
          const Icon = MODE_ICONS[key];
          const label = TICKET_RAIL_MODE_LABELS[key];
          const active = mode === key;
          return (
            <button
              key={key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`ticket-rail-tab-${key}`}
              aria-controls={`ticket-rail-page-${key}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={label}
              data-testid={`ticket-rail-tab-${key}`}
              onClick={() => onSelectMode(key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-8 items-center justify-center overflow-hidden rounded-full text-ui outline-none",
                "transition-[width,color,background-color,box-shadow,transform] duration-200 active:scale-[0.97]",
                PILL_EASE,
                "motion-reduce:transition-none motion-reduce:transform-none",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                active
                  ? "w-[84px] bg-sidebar-accent text-sidebar-accent-foreground shadow-xs"
                  : "w-8 text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {/* Clipped to zero rather than unmounted: the width animates, so
                  the label has to slide out of the same box it slid into. */}
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200",
                  PILL_EASE,
                  "motion-reduce:transition-none",
                  active ? "ml-1.5 max-w-16 opacity-100" : "ml-0 max-w-0 opacity-0",
                )}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RailPagePlaceholder({ label }: { label: string }) {
  return (
    <div
      data-testid={`ticket-rail-placeholder-${label.toLowerCase()}`}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
    >
      <p className="text-ui font-medium text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground/80">Nothing here yet</p>
    </div>
  );
}

export function TicketRail({
  projectId,
  ticket,
  creating,
  onNewSession,
  onNewChat,
  onActivateSession,
  onActivateChat,
  activeTabId,
  filesContent,
  changesContent,
}: {
  projectId: string;
  ticket: Ticket;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
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
   * Optional Files navigator. When omitted, a quiet placeholder renders so the
   * shell stays usable until the Files agent lands.
   */
  filesContent?: React.ReactNode;
  /** Optional Diffs navigator — same seam as `filesContent`. */
  changesContent?: React.ReactNode;
}) {
  const storedMode = useUiStore((state) => state.railMode);
  const setRailMode = useUiStore((state) => state.setRailMode);
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="ticket-rail">
      <TicketRailTabs mode={mode} modes={modes} onSelectMode={onSelectMode} />
      <section
        id={`ticket-rail-page-${mode}`}
        role="tabpanel"
        aria-labelledby={`ticket-rail-tab-${mode}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {mode === "now" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8 [scroll-padding-bottom:2rem]">
            <TicketRepositorySummary
              projectId={projectId}
              ticket={ticket}
              onShowChanges={showChanges}
            />
            <TicketProperties projectId={projectId} ticket={ticket} />
            <TicketSessionsPanel
              ticketId={ticket.id}
              creating={creating}
              onNewSession={onNewSession}
              onNewChat={onNewChat}
              onActivateSession={onActivateSession}
              onActivateChat={onActivateChat}
            />
            <TicketStamps ticket={ticket} />
          </div>
        ) : null}
        {mode === "changes" ? (changesContent ?? <RailPagePlaceholder label="Diffs" />) : null}
        {mode === "files" ? (filesContent ?? <RailPagePlaceholder label="Files" />) : null}
      </section>
    </div>
  );
}
