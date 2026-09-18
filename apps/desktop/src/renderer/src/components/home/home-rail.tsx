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
 *  • **Now** — what the Session in front IS and the tree it writes to, as ONE
 *    card (`home-session-card.tsx`), with the usage card under it. Two cards,
 *    nesting the same two scopes twice: Session inside project, once as
 *    identity and once as money. It was three drawings for that — a
 *    hand-rolled venue card, a `<dl>` of Model/Effort/Activity lines, and the
 *    rail's shared usage card — until VC-406.
 *  • **Sessions** — the project's OWN Sessions, and only those. A ticket's
 *    Sessions already live in that ticket's rail, so listing them here would
 *    make Home a second index of the same rows. What has no other home is the
 *    Board Session you closed, which reopens from here.
 *  • **Files** — the Main checkout navigator. It opens preview/pinned File tabs
 *    in Home rather than sending the whole app to a separate nav page.
 *  • **Search** — find across the same Main checkout (VC-193). The same page
 *    the ticket rail draws, at this scope: one component, two scopes, exactly
 *    as the two file navigators are one navigator.
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
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  effectiveHarnessId,
  harnessLabel,
  modelTierRow,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelSelection,
  type Project,
} from "@volli/shared";

import { FileSearchPanel } from "@renderer/components/files/search-panel";
import { HomeFilesPanel } from "@renderer/components/home/home-files-panel";
import {
  HomeSessionCard,
  type HomeSessionFacts,
  type HomeSessionModel,
} from "@renderer/components/home/home-session-card";
import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import { providerLabelOf } from "@renderer/components/models/model-identity";
import { terminalTabDot, terminalTabState } from "@renderer/components/sessions/terminal-tab-state";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { isFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { RailModeTabs, type RailModeTab } from "@renderer/components/ticket/rail-mode-tabs";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { HomeUsageRailCard } from "@renderer/components/usage/usage-rail";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import {
  HOME_RAIL_MODES,
  HOME_RAIL_MODE_LABELS,
  homeSessionRows,
  type HomeRailMode,
  type HomeSessionRow,
} from "@renderer/components/home/home-rail-model";
import { compactAge } from "@renderer/lib/relative-time";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  listableChats,
  projectSessionListingPending,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey } from "@renderer/stores/venue";
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
        {mode === "search" ? (
          // A match opens in the same replaceable preview slot a navigator row
          // does (decision #56) — the line it lands on is the search panel's
          // own business, through `editor/reveal-line.ts`.
          <FileSearchPanel
            scope={{ kind: "home", projectId: project.id }}
            root={project.name}
            onOpenMatch={(relPath) =>
              useWorkspaceStore.getState().previewHomeFile(project.id, relPath)
            }
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
  icon: {
    now: ChatCircleDotsIcon,
    sessions: ClockCounterClockwiseIcon,
    files: FoldersIcon,
    search: MagnifyingGlassIcon,
  }[key],
}));

/** Now: where this Session runs, and what it is. */
function NowPage({ projectId, activeTabId }: { projectId: string; activeTabId: string }) {
  const venue = useVenueStore((state) => state.byScope[venueKey(projectId, null)]);
  const ensureVenue = useVenueStore((state) => state.ensure);
  const facts = useSessionFacts(activeTabId);
  React.useEffect(() => {
    void ensureVenue(projectId, null);
  }, [projectId, ensureVenue]);

  return (
    <>
      {/* The Session in front and the tree it writes to, as ONE card (VC-406).
          They were two blocks in two drawings — a hand-rolled venue card over
          an uppercase eyebrow over a `<dl>` of Model/Effort/Activity lines —
          for what is one object at Home scope: a Home Session runs in the
          Main checkout by construction. The eyebrow pairs with the usage
          card's `Project` below it, so the page reads as two scopes rather
          than four blocks. */}
      <div className="flex flex-col gap-2 pt-4">
        <div className={RAIL_PANEL_INSET}>
          <SectionHeading as="h3">Session</SectionHeading>
        </div>
        <HomeSessionCard
          facts={facts}
          venue={venue}
          onRetryVenue={() => void useVenueStore.getState().refresh(projectId, null)}
        />
      </div>
      {/* The third scope (VC-87), as ONE card carrying both the project rollup
          and what the Session in front has contributed to it (VC-203). The
          Session's cost used to be three extra rows in the block above; two
          drawings of the same kind of number, a section apart, is what that
          bought. It renders nothing — padding included — when the reader has
          turned cost off, or when this project has never metered a model call. */}
      <HomeUsageRailCard projectId={projectId} sessionId={parseHomeChatTab(activeTabId)} />
    </>
  );
}

/**
 * What the Session in front IS, read from the stores that hold it — the
 * drawing is `home-session-card.tsx`.
 *
 * THREE CASES, and each is a different kind of thing rather than a missing
 * field of one kind. The Board tab (and a file tab) is not a Session at all.
 * A chat is a model and an effort. A TERMINAL is neither — it is a PTY, and
 * asking it for a model would print two dashes and call that a reading, so it
 * answers with what it actually has: what is running in it, and whether that
 * is still alive.
 *
 * ONE HOOK RATHER THAN THE TWO COMPONENTS THIS WAS. A component per case let
 * each read only its own stores, which is why it was shaped that way; but the
 * cases have to produce one object now, and a hook that branched its reads
 * would break the rules of hooks the first time the front tab changed kind.
 * The reads that do not apply are cheap: a null id is answered without
 * touching the store's maps.
 */
function useSessionFacts(activeTabId: string): HomeSessionFacts {
  const catalog = useModelCatalog();
  const sessionId = React.useMemo(() => parseHomeChatTab(activeTabId), [activeTabId]);
  // Whatever is in front and is not the Board, a file tab or a chat is a
  // terminal — the same elimination the block did before this was one hook.
  const terminalId =
    isHomeBoardTab(activeTabId) || isFileTabId(activeTabId) || sessionId !== null
      ? null
      : activeTabId;

  const projection = useChatSessionsStore((state) =>
    sessionId === null ? null : (state.sessions[sessionId]?.projection ?? null),
  );
  const lifecycle = useChatSessionsStore((state) =>
    sessionId === null ? null : (state.sessions[sessionId]?.lifecycle ?? null),
  );
  const tab = useSessionsStore((state) =>
    terminalId === null
      ? undefined
      : Object.values(state.byOwner)
          .flatMap((container) => container.tabs)
          .find((candidate) => candidate.sessionId === terminalId),
  );
  const parkState = useSessionsStore((state) => state.parkState);
  const record = useProjectSessionsStore((state) =>
    terminalId === null
      ? undefined
      : Object.values(state.byProject)
          .flatMap((rows) => rows.terminal)
          .find((row) => row.id === terminalId),
  );

  if (terminalId !== null) {
    if (tab === undefined) return null;
    // The dot is `terminal-tab-state.ts`'s — the same derivation the strip's
    // own tab draws from, so the rail and the tab can never disagree about
    // whether a PTY is still there. `null` from it means PARKED, the one state
    // that tab expresses by drawing no dot at all and this surface can name.
    const dot = terminalTabDot(terminalTabState(tab, parkState));
    return {
      kind: "terminal",
      running: record === undefined ? "Terminal" : harnessLabel(effectiveHarnessId(record)),
      activity: dot ?? "parked",
    };
  }
  if (sessionId === null) return null;

  const selection = projection?.modelSelection ?? null;
  // The tier the model resolved from (VC-259), where a start named one; the
  // same "Fast" the composer's pill reads, so the two agree.
  const tier = projection?.modelTier ?? null;
  const waiting = (projection?.interactions.active.length ?? 0) > 0;
  // `ChatSessionLifecycle` is a subset of the dot's vocabulary by construction
  // (starting/ready/working/error), and `waiting` outranks all of it: an agent
  // that has stopped to ask something is still inside an open turn, so the live
  // dot would otherwise say "leave this alone" about a Session asking for you.
  const activity: StatusDotState = waiting ? "waiting" : (lifecycle ?? "idle");

  return {
    kind: "chat",
    // Null, never a dash: a Session that has not accepted a model policy yet
    // has no model to name, and the card says what it IS instead of drawing a
    // title made of punctuation.
    model: selection === null ? null : namedModel(selection, catalog),
    tier: tier === null ? null : modelTierRow(tier).label,
    effort: selection?.reasoningLevel ?? null,
    activity,
  };
}

/**
 * A selection, named against the catalogue: `claude-opus-4-1` → "Claude Opus
 * 4.1", with the vendor's mark beside it (`models/model-identity.tsx`).
 *
 * A selection the catalogue does not hold — or one drawn before the inspection
 * lands — keeps its raw id as its label, which is the composer pill's own
 * fallback. Neither is a failure state: a provider signed out from under a
 * pinned Session still leaves the Session pinned, and the id is what it is
 * pinned TO.
 */
function namedModel(selection: ModelSelection, catalog: ModelCatalog): HomeSessionModel {
  const listed = catalog.models.find(
    (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
  );
  return {
    model: listed ?? {
      providerId: selection.providerId,
      modelId: selection.modelId,
      label: selection.modelId,
    },
    providerLabel: providerLabelOf(catalog.providers, selection.providerId),
  };
}

interface ModelCatalog {
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
}

const EMPTY_CATALOG: ModelCatalog = { models: [], providers: [] };

/**
 * What Model Access knows, for naming the model the front Session is pinned to.
 *
 * THIS COSTS NO EXTRA IPC IN THE ORDINARY CASE. `inspect` is held per
 * revision by `ModelAccessProvider`, so a rail asking while a composer has
 * already asked joins that read instead of starting a second one; a later
 * mount is answered from the held promise entirely. The revision is the
 * dependency, so a sign-in or a Refresh re-reads and a rail on screen renames
 * itself without being told.
 *
 * A FAILED READ IS SILENT, deliberately, and it is the narrow exception
 * CLAUDE.md carves out rather than a swallowed error: nobody is waiting on
 * this. The row is already drawn from the Session's own projection and stays
 * drawn — the id in place of the name — so the whole consequence of the
 * failure is a less friendly spelling of a value that is already correct. A
 * toast here would fire on every offline start to report that.
 */
function useModelCatalog(): ModelCatalog {
  const client = useModelAccessClient();
  const revision = client?.revision ?? 0;
  const [catalog, setCatalog] = React.useState<ModelCatalog>(EMPTY_CATALOG);

  React.useEffect(() => {
    if (client === null) return;
    let live = true;
    void client
      .inspect({})
      .then((snapshot) => {
        if (live) setCatalog({ models: snapshot.models, providers: snapshot.providers });
      })
      .catch(() => {
        if (live) setCatalog(EMPTY_CATALOG);
      });
    return () => {
      live = false;
    };
    // `revision` stands for what the client would answer; the client object
    // itself is stable for the life of the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, revision]);

  return catalog;
}

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
  // Whether the project's listing has ever answered (VC-383). Before it has,
  // the rows below are empty because nothing has been READ, not because there
  // is nothing — and "No sessions yet" about a project mid-turn is a false
  // sentence for the length of the read. The store already keeps this bit;
  // this page is one of the surfaces that used to leave it unread.
  const listingState = useProjectSessionsStore((state) => state.listingState[projectId]);
  const pending = projectSessionListingPending(listingState);
  const failed = listingState === "failed";

  // `listableChats` rather than `.chat`: this page draws rows, so it takes the
  // narrowed read at the door — see the store's own comment for which
  // consumers take the whole cache instead, and why.
  const chats = useProjectSessionsStore(
    useShallow((state) =>
      listableChats(state.byProject[projectId]).filter((row) => row.ticketId === null),
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
      <SectionHeading as="h3">Board sessions</SectionHeading>
      {rows.length === 0 && pending ? (
        <div
          className="flex flex-col"
          {...loadingRegionProps("sessions")}
          data-testid="home-sessions-loading"
        >
          {(["w-3/5", "w-2/5"] as const).map((width) => (
            <ListRowSkeleton key={width} mark primaryWidth={width} trailingWidth="w-10" />
          ))}
        </div>
      ) : rows.length === 0 && failed ? (
        // A refused baseline knows nothing about this Project's durable
        // Sessions. The toast has the bridge detail; this concise line keeps
        // the rail from claiming that a failed read proved the list empty.
        <p className={EMPTY_INLINE}>Couldn&apos;t load sessions.</p>
      ) : rows.length === 0 ? (
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
              // Draggable onto a pane (VC-202 §4): the same door, opened
              // somewhere specific.
              {...splitDragSourceProps(homeSessionDragPayload(projectId, row))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_IDS: readonly string[] = [];

/**
 * What one of these rows would open if it were dropped on a pane, or `null` for
 * a row that is not a door.
 *
 * A chat drags whether or not a tab holds it — the Session is durable, so the
 * drop adopts it and mints one, exactly as clicking would. A terminal drags
 * only while it is OPEN: the tab is what a pane holds, and `reopenable` is
 * already this list's word for "a closed terminal has nothing behind it".
 */
function homeSessionDragPayload(projectId: string, row: HomeSessionRow): SplitDragPayload | null {
  if (row.kind === "terminal" && !row.open) return null;
  if (!row.reopenable) return null;
  return {
    type: "session",
    scope: "project",
    projectId,
    ticketId: null,
    kind: row.kind,
    sessionId: row.id,
  };
}

/**
 * Put a Session back in front.
 *
 * Both kinds route through `openHome`, the same seam the sidebar's bands and
 * ⌘K use — a chat is adopted and given a tab first, because the strip cannot
 * bring forward a tab that does not exist yet. Reopening a CLOSED chat is the
 * case this page exists for: a Board Session outlives its tab, and until now
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
