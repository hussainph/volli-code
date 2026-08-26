/**
 * Home's right rail — the ticket workspace's Calm Stack one scope up (VC-55).
 *
 * WHY IT EXISTS. The empty chat answers "where does this Session run" only
 * while it is empty, which is exactly as long as it takes to type one message.
 * Everything after that is a transcript, and nothing on the surface said which
 * directory the agent was writing to. This is the mid-session answer, and it is
 * the same ⌥⌘B panel the ticket workspace has — parity rather than a new idea,
 * because Home and a ticket workspace are the same object at two scopes.
 *
 * THREE PAGES, scoped to the Main checkout and the project's own work:
 *
 *  • **Now** — the venue this Session stands in, and what the Session is.
 *  • **Sessions** — the project's OWN Sessions, and only those. A ticket's
 *    Sessions already live in that ticket's rail, so listing them here would
 *    make Home a second index of the same rows. What has no other home is the
 *    Project Session you closed, which reopens from here.
 *  • **Files** — the Main checkout navigator. It opens preview/pinned File tabs
 *    in Home rather than sending the whole app to a separate nav page.
 *
 * WHAT IS DELIBERATELY NOT HERE. The "Mentioned" block the design calls for —
 * the tickets a transcript wrote `@vc-nn` at — needs the backlink mechanism
 * that is VC-104's, and is absent rather than empty until it lands: a section
 * that can never fill in this build is furniture, and inventing a different
 * relevance rule to fill it would be worse than not having it.
 *
 * Nothing in here collapses the rail — a panel cannot reopen itself, so that
 * control lives outside it, in the tab strip's corner, exactly as the ticket
 * rail's does.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { effectiveHarnessId, harnessLabel, venueLooseCount, type Project } from "@volli/shared";

import { venueKindLabel } from "@renderer/components/chat/empty/venue-chips";
import { HomeFilesPanel } from "@renderer/components/home/home-files-panel";
import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import { terminalTabDot, terminalTabState } from "@renderer/components/sessions/terminal-tab-state";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { isFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import {
  ProjectUsageRailBlock,
  SessionUsageRailFacts,
} from "@renderer/components/usage/usage-rail";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import {
  HOME_RAIL_MODES,
  HOME_RAIL_MODE_LABELS,
  homeSessionRows,
  venuePathTail,
  type HomeRailMode,
  type HomeSessionRow,
} from "@renderer/components/home/home-rail-model";
import { compactAge } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey, type VenueEntry } from "@renderer/stores/venue";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Every rail block is the same shape at the same inset — one seam, spelled once. */
const SECTION = cn("flex flex-col gap-2 pt-4", RAIL_PANEL_INSET);

export function HomeRail({
  project,
  activeTabId,
}: {
  project: Project;
  /**
   * Which Home tab is in front, resolved once by `home-surface.tsx`. Read here
   * only to say which Session the Now page is about — never re-derived: two
   * answers to that question is the disagreement VC-54 removed.
   */
  activeTabId: string;
}) {
  const mode = useUiStore((state) => state.homeRailMode);
  const setMode = useUiStore((state) => state.setHomeRailMode);

  return (
    <div
      className="group/rail flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="home-rail"
      data-narrow="false"
    >
      <RailModeTabs
        modes={HOME_MODE_TABS}
        active={mode}
        label="Home rail pages"
        idPrefix="home-rail"
        onSelect={setMode}
      />
      {/* No overflow of its own: each page owns its scroll container, exactly as
          the ticket rail's panel does. The navigator scrolls its own list under
          a header that must not move, and Now/Sessions scroll as one column —
          a rule here could only be one of those two, with the other spelled as
          an exception to it. */}
      <section
        id={`home-rail-page-${mode}`}
        role="tabpanel"
        aria-labelledby={`home-rail-tab-${mode}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {mode === "now" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8">
            <NowPage projectId={project.id} activeTabId={activeTabId} />
          </div>
        ) : null}
        {mode === "sessions" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-8">
            <SessionsPage projectId={project.id} />
          </div>
        ) : null}
        {mode === "files" ? (
          <HomeFilesPanel
            project={project}
            onPreviewFile={(relPath) =>
              useWorkspaceStore.getState().previewHomeFile(project.id, relPath)
            }
            onPinFile={(relPath) => useWorkspaceStore.getState().pinHomeFile(project.id, relPath)}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Home's pages, in pill order, as {@link RailModeTabs} takes them. Built once
 * at module scope: the set is fixed, so rebuilding it per render would hand
 * the pill a fresh array on every keystroke elsewhere in the app.
 */
const HOME_MODE_TABS: readonly RailModeTab<HomeRailMode>[] = HOME_RAIL_MODES.map((key) => ({
  key,
  label: HOME_RAIL_MODE_LABELS[key],
  icon: { now: ChatCircleDotsIcon, sessions: ClockCounterClockwiseIcon, files: FoldersIcon }[key],
}));

/** Now: where this Session runs, and what it is. */
function NowPage({ projectId, activeTabId }: { projectId: string; activeTabId: string }) {
  const venue = useVenueStore((state) => state.byScope[venueKey(projectId, null)]);
  const ensureVenue = useVenueStore((state) => state.ensure);
  React.useEffect(() => {
    void ensureVenue(projectId, null);
  }, [projectId, ensureVenue]);

  return (
    <>
      <div className={SECTION}>
        <SectionHeading as="h3">Venue</SectionHeading>
        <VenueCard venue={venue} />
      </div>
      <div className={SECTION}>
        <SectionHeading as="h3">Session</SectionHeading>
        <SessionFacts activeTabId={activeTabId} />
      </div>
      {/* The third scope (VC-87). Usage is a fact each scope carries rather
          than a section of its own — a block headed "Usage" under a Session
          block that also reports usage would be two sections with one name. It
          renders nothing when the reader has turned cost off, or when this
          project has never metered a model call. */}
      <div className={SECTION}>
        <ProjectUsageRailBlock projectId={projectId} />
      </div>
    </>
  );
}

/**
 * The venue card: the path, the branch, and how much is loose in it.
 *
 * A failure is NAMED here rather than swallowed, which is the half of the
 * contract the empty chat cannot keep — a drawing can be absent, but a card
 * that is about the venue and says nothing about it is a card that has gone
 * quiet on the one thing it exists for.
 */
function VenueCard({ venue }: { venue: VenueEntry | undefined }) {
  if (venue === undefined || venue.status === "loading") {
    return <div className="h-16 rounded-row border border-border bg-card" aria-hidden />;
  }
  if (venue.status === "error") {
    return (
      <p className="rounded-row border border-border bg-card p-4 text-ui text-muted-foreground">
        {venue.error}
      </p>
    );
  }
  const loose = venueLooseCount(venue.venue.files);
  return (
    <div className="flex flex-col gap-2 rounded-row border border-border bg-card p-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <p className="truncate text-left font-mono text-ui text-foreground">
            {venuePathTail(venue.venue.path)}
          </p>
        </TooltipTrigger>
        <TooltipContent side="left" className="font-mono">
          {venueKindLabel(venue.venue)} · {venue.venue.path}
        </TooltipContent>
      </Tooltip>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground">
          <GitBranchIcon weight="bold" className="size-3 shrink-0" />
          <span className="truncate">{venue.venue.branch ?? "detached"}</span>
        </span>
        {/* Silent at zero: a clean tree has nothing to report, and "0 loose"
            is a number where there is no news. */}
        {loose === 0 ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 items-center gap-1 text-ui text-attention tabular-nums">
                <StatusDot state="waiting" />
                {loose}
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">
              {loose} uncommitted {loose === 1 ? "file" : "files"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * What the Session in front is.
 *
 * THREE CASES, and each is a different kind of thing rather than a missing
 * field of one kind. The Board tab is not a Session at all and says so in a
 * line. A chat is a model and an effort. A TERMINAL is neither — it is a PTY,
 * and asking it for a model would print two dashes and call that a reading, so
 * it answers with what it actually has: what is running in it, and whether that
 * is still alive.
 */
function SessionFacts({ activeTabId }: { activeTabId: string }) {
  const sessionId = React.useMemo(() => parseHomeChatTab(activeTabId), [activeTabId]);
  const terminal =
    isHomeBoardTab(activeTabId) || isFileTabId(activeTabId) || sessionId !== null
      ? null
      : activeTabId;
  const projection = useChatSessionsStore((state) =>
    sessionId === null ? null : (state.sessions[sessionId]?.projection ?? null),
  );
  const lifecycle = useChatSessionsStore((state) =>
    sessionId === null ? null : (state.sessions[sessionId]?.lifecycle ?? null),
  );

  if (terminal !== null) return <TerminalFacts sessionId={terminal} />;
  if (sessionId === null) {
    return <p className={EMPTY_INLINE}>No session in front</p>;
  }
  const selection = projection?.modelSelection ?? null;
  const waiting = (projection?.interactions.active.length ?? 0) > 0;
  // `ChatSessionLifecycle` is a subset of the dot's vocabulary by construction
  // (starting/ready/working/error), and `waiting` outranks all of it: an agent
  // that has stopped to ask something is still inside an open turn, so the live
  // dot would otherwise say "leave this alone" about a Session asking for you.
  const activity: StatusDotState = waiting ? "waiting" : (lifecycle ?? "idle");

  return (
    <dl className="flex flex-col gap-2">
      <Fact label="Model">{selection?.modelId ?? "—"}</Fact>
      <Fact label="Effort">{selection?.reasoningLevel ?? "—"}</Fact>
      <Fact label="Activity">
        <span className="flex items-center gap-1">
          <StatusDot state={activity} />
          {ACTIVITY_LABEL[activity]}
        </span>
      </Fact>
      {/* Cost, tokens and cached share, as three more facts about this Session
          (VC-87) — inside the same `<dl>` because they describe the thing the
          rows above name, not a new subject. Silent until something has been
          metered, so a Session that has not replied yet shows no zeroes. */}
      <SessionUsageRailFacts sessionId={sessionId} />
    </dl>
  );
}

/**
 * A terminal tab's facts: what is running in it, and its liveness.
 *
 * The dot is `terminal-tab-state.ts`'s — the same derivation the strip's own
 * tab draws from, so the rail and the tab can never disagree about whether a
 * PTY is still there. `null` from it means PARKED, which is the one state that
 * tab expresses by drawing no dot at all and this surface has room to name.
 */
function TerminalFacts({ sessionId }: { sessionId: string }) {
  const tab = useSessionsStore((state) =>
    Object.values(state.byOwner)
      .flatMap((container) => container.tabs)
      .find((candidate) => candidate.sessionId === sessionId),
  );
  const parkState = useSessionsStore((state) => state.parkState);
  const record = useProjectSessionsStore((state) =>
    Object.values(state.byProject)
      .flatMap((rows) => rows.terminal)
      .find((row) => row.id === sessionId),
  );

  if (tab === undefined) return <p className={EMPTY_INLINE}>No session in front</p>;
  const state = terminalTabState(tab, parkState);
  const dot = terminalTabDot(state);
  const activity: StatusDotState = dot ?? "parked";

  return (
    <dl className="flex flex-col gap-2">
      <Fact label="Running">
        {record === undefined ? "Terminal" : harnessLabel(effectiveHarnessId(record))}
      </Fact>
      <Fact label="Activity">
        <span className="flex items-center gap-1">
          <StatusDot state={activity} />
          {ACTIVITY_LABEL[activity]}
        </span>
      </Fact>
    </dl>
  );
}

/** One key/value line in the Session block. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-ui text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-ui text-foreground">{children}</dd>
    </div>
  );
}

/** The dot's own vocabulary, in words. */
const ACTIVITY_LABEL: Record<StatusDotState, string> = {
  working: "Working",
  setup: "Setting up",
  ready: "Ready",
  starting: "Starting",
  waiting: "Waiting for you",
  error: "Failed",
  idle: "Idle",
  parked: "Parked",
  exited: "Ended",
  stopped: "Stopped",
};

/** The chat Session a Home tab id names, or `null` for the Board and terminals. */
function parseHomeChatTab(activeTabId: string): string | null {
  const prefix = chatTabId("");
  return activeTabId.startsWith(prefix) && activeTabId.length > prefix.length
    ? activeTabId.slice(prefix.length)
    : null;
}

/**
 * Sessions: the project's own, and only those.
 *
 * Rendered off the durable per-project listing VC-54 shipped
 * (`stores/project-sessions.ts`) rather than re-indexed here — the sidebar's
 * bands and ⌘K read the same rows, and a second index of them would be a second
 * answer to "what has this project been doing".
 */
function SessionsPage({ projectId }: { projectId: string }) {
  const ensure = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    void ensure(projectId);
  }, [projectId, ensure]);

  const chats = useProjectSessionsStore(
    useShallow((state) =>
      (state.byProject[projectId]?.chat ?? []).filter((row) => row.ticketId === null),
    ),
  );
  const terminals = useProjectSessionsStore(
    useShallow((state) =>
      (state.byProject[projectId]?.terminal ?? []).filter((row) => row.ticketId === null),
    ),
  );
  const openChatIds = useChatSessionsStore(
    useShallow((state) => state.openTabs[projectId] ?? EMPTY_IDS),
  );
  const openTerminalIds = useSessionsStore(
    useShallow((state) => (state.byOwner[projectId]?.tabs ?? []).map((tab) => tab.sessionId)),
  );

  const rows = React.useMemo(
    () => homeSessionRows(chats, terminals, openChatIds, openTerminalIds),
    [chats, terminals, openChatIds, openTerminalIds],
  );

  return (
    <div className={SECTION}>
      <SectionHeading as="h3">Project sessions</SectionHeading>
      {rows.length === 0 ? (
        <p className={EMPTY_INLINE}>No sessions yet</p>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <ListRow
              key={row.id}
              leading={<RowMark row={row} />}
              primary={row.title}
              trailing={
                <span className="shrink-0 text-label text-muted-foreground">
                  {row.open ? "Open" : compactAge(row.at)}
                </span>
              }
              className={row.open ? undefined : "text-muted-foreground"}
              onActivate={row.reopenable ? () => openSession(projectId, row) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_IDS: readonly string[] = [];

/**
 * Put a Session back in front.
 *
 * Both kinds route through `openHome`, the same seam the sidebar's bands and
 * ⌘K use — a chat is adopted and given a tab first, because the strip cannot
 * bring forward a tab that does not exist yet. Reopening a CLOSED chat is the
 * case this page exists for: a Project Session outlives its tab, and until now
 * the only way back to one was the sidebar.
 *
 * Only ever called for a row that IS a door — `HomeSessionRow.reopenable`, which
 * is where a dead terminal is turned away, and it is turned away by not being a
 * target at all rather than by being one that lands nowhere.
 */
function openSession(projectId: string, row: HomeSessionRow): void {
  const workspace = useWorkspaceStore.getState();
  if (row.kind === "chat") {
    const chat = useChatSessionsStore.getState();
    chat.adoptChatSession(row.id);
    chat.openChatTab(projectId, row.id);
    workspace.openHome(projectId, chatTabId(row.id));
    return;
  }
  useSessionsStore.getState().setActiveSession(projectId, row.id);
  workspace.openHome(projectId, row.id);
}

/**
 * A row's leading marks: liveness, then which surface it runs on.
 *
 * Both, because neither answers the other's question and this page mixes the
 * two kinds in one list. `bold` at 12px for the same reason the sidebar's band
 * gives: at this size regular draws lighter than the title the glyph leads, and
 * a mark that opens a row cannot be the faintest thing in it.
 */
function RowMark({ row }: { row: HomeSessionRow }) {
  const Glyph = row.kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <StatusDot state={row.state} />
      <Glyph
        weight="bold"
        aria-label={row.kind === "chat" ? "Chat" : "Terminal"}
        className="size-3 text-muted-foreground"
      />
    </span>
  );
}
