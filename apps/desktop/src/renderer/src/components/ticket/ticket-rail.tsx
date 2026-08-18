/**
 * Ticket detail right rail — the Calm Stack (decision #46; designed in the
 * ticket-right-sidebar lab scratch, since retired — this file reproduces its
 * `SidebarPanel` + `ActiveLabelTabs` + `NowPanel` and is now the design of
 * record).
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
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitDiffIcon } from "@phosphor-icons/react/dist/csr/GitDiff";
import type { SkillReference, Ticket } from "@volli/shared";

import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TicketRepositorySummary } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketSessionsPanel } from "@renderer/components/ticket/ticket-sessions-panel";
import {
  TICKET_RAIL_MODE_LABELS,
  availableRailModes,
  resolveRailMode,
  selectRailMode,
  type TicketRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { RAIL_MIN_WIDTH, useUiStore } from "@renderer/stores/ui";

const MODE_ICONS: Record<TicketRailMode, PhosphorIcon> = {
  now: ChatCircleDotsIcon,
  changes: GitDiffIcon,
  files: FoldersIcon,
};

/**
 * Above this width the rail takes the design's roomy 16px edge inset; at or
 * below it, 12px. The scratch offered three fixed widths and drew only its
 * 240px floor narrow, so the boundary sits between the two it tested (240 and
 * 300) — the app's rail resizes continuously and has to answer for 260px too.
 */
const RAIL_NARROW_MAX_WIDTH = (RAIL_MIN_WIDTH + 300) / 2;

/**
 * The rail's header: a centred tablist where only the selected tab wears its
 * label, so three pages fit a 160px pill at the rail's narrowest width without
 * ever truncating a word. Presentational — page state lives in the UI store.
 *
 * Translucent and blurred rather than opaque: at `top-0` of a column whose
 * pages scroll beneath it, the bar is a floating material, not a strip the
 * layout gives away.
 *
 * The selection is a Motion layout animation, not a width transition. A CSS
 * transition can grow the selected tab, but it cannot make the two tabs beside
 * it travel with it — they jump to their new x as soon as the flex row
 * reflows. `layout` measures both frames, so the whole pill rearranges as one
 * object. Arrow-key navigation deliberately opts out (`animateSelection`): a
 * held arrow key walks the tablist faster than a 320ms settle, and an
 * animation that is always mid-flight reads as lag rather than motion.
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
  const [animateSelection, setAnimateSelection] = React.useState(true);
  const reducedMotion = useReducedMotion() ?? false;
  const animated = animateSelection && !reducedMotion;

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
    setAnimateSelection(false);
    onSelectMode(nextMode);
    refs.current[next]?.focus();
  }

  return (
    <div
      className={cn(
        "sticky top-0 z-20 shrink-0 bg-sidebar/70 pt-4 pb-4 backdrop-blur-xl",
        RAIL_PANEL_INSET,
      )}
    >
      <div
        role="tablist"
        aria-label="Ticket rail pages"
        // No height of its own: the `h-8` tabs inside it plus `p-1` ARE the
        // height (40px), so the track can never disagree with what it holds.
        className="mx-auto flex w-40 items-center gap-1 rounded-full border border-sidebar-border bg-background/70 p-1 shadow-raised"
      >
        {modes.map((key, index) => {
          const Icon = MODE_ICONS[key];
          const label = TICKET_RAIL_MODE_LABELS[key];
          const active = mode === key;
          const tab = (
            <motion.button
              layout={animated}
              transition={
                animated ? { type: "spring", duration: 0.32, bounce: 0.1 } : { duration: 0 }
              }
              key={key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`ticket-rail-tab-${key}`}
              aria-controls={`ticket-rail-page-${key}`}
              aria-selected={active}
              aria-label={label}
              tabIndex={active ? 0 : -1}
              data-testid={`ticket-rail-tab-${key}`}
              onClick={() => {
                setAnimateSelection(true);
                onSelectMode(key);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-8 items-center justify-center gap-1 overflow-hidden rounded-full text-ui outline-none",
                active ? "w-[84px]" : "w-8",
                // `scale-100!` is the press's reduced-motion cancel: dropping
                // the transition below only made the depress instant, it never
                // removed it, and `transform-none` could not have — see the
                // press note in `ui/button.tsx`.
                "focus-visible:ring-2 focus-visible:ring-ring/45 active:scale-[0.97] motion-reduce:scale-100!",
                !reducedMotion &&
                  "transition-[color,background-color,box-shadow,transform,scale] duration-150 ease-out",
                active
                  ? "bg-accent text-foreground shadow-raised"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <motion.span layout="position" className="flex shrink-0 items-center">
                <Icon className="size-3.5" />
              </motion.span>
              <AnimatePresence initial={false} mode="popLayout">
                {active ? (
                  <motion.span
                    key={`${key}-label`}
                    initial={animated ? { opacity: 0, transform: "translateX(-4px)" } : false}
                    animate={{ opacity: 1, transform: "translateX(0)" }}
                    exit={animated ? { opacity: 0, transform: "translateX(3px)" } : { opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0 : 0.14, ease: [0.23, 1, 0.32, 1] }}
                    className="whitespace-nowrap"
                  >
                    {label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </motion.button>
          );
          // The selected tab already wears its name, so its tooltip would only
          // repeat it — `open={false}` keeps the trigger's accessibility wiring
          // without ever showing the bubble.
          return (
            <Tooltip key={key} open={active ? false : undefined}>
              <TooltipTrigger asChild>{tab}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

export function TicketRail({
  projectId,
  ticket,
  creating,
  onNewSession,
  onNewChat,
  skills,
  onNewChatWithSkill,
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
  /** The project's skills — the "Chat with skill" submenu's rows. */
  skills?: readonly SkillReference[];
  /** Mints a chat Session with one named skill injected at attach time. */
  onNewChatWithSkill?(name: string): void;
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
      <TicketRailTabs mode={mode} modes={modes} onSelectMode={onSelectMode} />
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
            <TicketSessionsPanel
              ticketId={ticket.id}
              creating={creating}
              onNewSession={onNewSession}
              onNewChat={onNewChat}
              skills={skills}
              onNewChatWithSkill={onNewChatWithSkill}
              onActivateSession={onActivateSession}
              onActivateChat={onActivateChat}
            />
          </div>
        ) : null}
        {mode === "changes" ? changesContent : null}
        {mode === "files" ? filesContent : null}
      </section>
    </div>
  );
}
