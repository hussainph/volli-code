/**
 * The setup an app-level scratch needs before it can render: the stores the
 * shell reads at mount, and the bridge channels it calls on the way up.
 *
 * This exists so the shell/chrome/board/sidebar scratches don't each re-derive
 * "what does the app need in order to boot" — that answer belongs in one place,
 * because it changes whenever the app's boot path does, and five copies would
 * drift apart silently.
 *
 * It is deliberately NOT a fake `lib/boot.ts`. Boot's job is to read SQLite
 * through the bridge and hydrate from the result; this writes the *outcome* of
 * that straight into the stores. Copying boot's sequencing would be reimplementing
 * the thing the lab is supposed to be measuring — and none of it is what a
 * design question is ever about.
 */
import type { SessionListingRow } from "@volli/shared";
import type {
  AppStateSetResult,
  HarnessPendingResult,
  HarnessRegisteredResult,
  Result,
  RetentionStateResult,
  RetentionTtlResult,
  SessionsResult,
  TicketIdInput,
  TicketLatestSignalsResult,
  TicketRetentionState,
  TicketStatusEntriesResult,
} from "../../ipc/contract";

import { EMPTY_NAV_HISTORY } from "@renderer/lib/nav-history";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useThemeStore } from "@renderer/stores/theme";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import type { ApiOverrides } from "./fake-api";
import { chatSessions, labels, project, projects, sessions, signals, tickets } from "./fixtures";

/**
 * A ticket whose worktree is safe to reclaim — the one row that renders the
 * retention badge, so the affordance is visible without every card shouting.
 */
const ARCHIVE_READY_TICKET_ID = "tkt-11";
let retentionTtlDays = 14;

/**
 * `fixtures.ts`'s durable Sessions, wrapped into the discriminated listing shape
 * `sessions.list`/`listForTicket` actually return — both kinds, because a
 * listing that returned only terminals is exactly the shape that used to make a
 * structured-only Session disappear.
 */
const sessionRows: SessionListingRow[] = [
  ...sessions.map((record): SessionListingRow => ({ kind: "terminal", record })),
  ...chatSessions.map((record): SessionListingRow => ({ kind: "chat", record })),
];

function retentionState(ticketId: string): TicketRetentionState {
  const archiveReady = ticketId === ARCHIVE_READY_TICKET_ID;
  return {
    ticketId,
    prUrl: archiveReady ? "https://github.com/demo/voltaic/pull/482" : null,
    prState: archiveReady ? "merged" : null,
    hasConflicts: false,
    failingChecks: [],
    archiveReady,
    reason: archiveReady ? "pr-merged" : null,
    keep: false,
    dismissed: false,
  };
}

/**
 * The bridge channels the app shell reaches for while mounting, answered with
 * fixture data.
 *
 * Only the ones that would otherwise be *wrong* rather than merely absent are
 * here. An unstubbed channel already degrades into the app's real failure path
 * (see fake-api.ts), which is usually the honest thing to show — but three
 * kinds of call are not:
 *
 *   • value members (`app.launchedByCli`), which read truthy unstubbed and
 *     would fire a "launched by an agent" toast on every scratch;
 *   • the few channels that resolve a RAW value rather than a Result
 *     (`window.isFullScreen`) — the failure Result is an object, so it reads
 *     truthy where a `false` was meant, and the chrome band drops its
 *     traffic-light spacer as if the window were fullscreen;
 *   • the data the surface under test exists to display, which would leave the
 *     sidebar permanently empty;
 *   • fire-and-forget housekeeping (`projects.syncRoots`, `appState.set`),
 *     whose only visible effect on failure is an error toast covering the
 *     design you came to look at.
 *
 * Everything else is left to fail on purpose. `fs.listDirectory` is the good
 * example: the lab has no filesystem, and the file tree's real empty/error
 * state is a more useful thing to look at than a fabricated directory.
 */
export const appApi: ApiOverrides = {
  app: { launchedByCli: false },
  window: {
    isFullScreen: (): Promise<boolean> => Promise.resolve(false),
  },
  appState: {
    set: (): Promise<AppStateSetResult> => Promise.resolve({ ok: true }),
  },
  projects: {
    syncRoots: (): Promise<void> => Promise.resolve(),
  },
  files: {
    // Watching succeeds and then nothing ever changes, which is the truth: the
    // lab has no files to watch. Left failing, its toast ("Live updates for the
    // project root unavailable") sits over the board on every load.
    watchDir: (): Promise<Result> => Promise.resolve({ ok: true }),
    unwatchDir: (): Promise<Result> => Promise.resolve({ ok: true }),
  },
  harness: {
    pending: (): Promise<HarnessPendingResult> =>
      Promise.resolve({ ok: true, pending: [], broken: [] }),
    registered: (): Promise<HarnessRegisteredResult> =>
      Promise.resolve({ ok: true, harnesses: [], channels: [] }),
  },
  sessions: {
    list: (): Promise<SessionsResult> => Promise.resolve({ ok: true, sessions: sessionRows }),
    listForTicket: (input: TicketIdInput): Promise<SessionsResult> =>
      Promise.resolve({
        ok: true,
        sessions: sessionRows.filter((row) => row.record.ticketId === input.ticketId),
      }),
  },
  tickets: {
    latestSignals: (): Promise<TicketLatestSignalsResult> => Promise.resolve({ ok: true, signals }),
    // Empty rather than fabricated: this is the board's column history, and the
    // listing rules already treat "no history" as "keep the Sessions you have".
    // So an empty answer is the honest one for a lab with no board behind it —
    // and it is what stops `Couldn't load ticket history` toasting over every
    // sidebar scratch on load.
    statusEntries: (): Promise<TicketStatusEntriesResult> =>
      Promise.resolve({ ok: true, entries: [] }),
  },
  retention: {
    state: (ticketId: string): Promise<RetentionStateResult> =>
      Promise.resolve({ ok: true, state: retentionState(ticketId) }),
    getTtlDays: (): Promise<RetentionTtlResult> =>
      Promise.resolve({ ok: true, days: retentionTtlDays }),
    setTtlDays: (days: number): Promise<RetentionTtlResult> => {
      retentionTtlDays = Math.max(1, Math.round(days));
      return Promise.resolve({ ok: true, days: retentionTtlDays });
    },
  },
};

/** Tickets and labels for the demo project, in the shape the board store holds them. */
export function seedBoard(): void {
  useBoardStore.setState({
    ticketsByProject: { [project.id]: tickets },
    labelsByProject: { [project.id]: labels },
  });
}

/**
 * Everything an app-level scratch needs: the rail's projects with one selected,
 * the board's tickets, and a workspace parked on the Board nav.
 *
 * It also RESETS the chrome and session state rather than only adding to it.
 * The shell installs each scratch's bridge stubs wholesale, so those can't leak
 * between scratches — but `seed` writes into singleton stores, which can. The
 * dangerous direction is sessions: a scratch that seeded a live-looking session
 * container would, on the next scratch, have the app shell try to mount a
 * terminal for a PTY that never existed. Anything a lab scratch is allowed to
 * set, this puts back.
 *
 * The theme store is seeded `hydrated: true` and otherwise left on its own
 * defaults: the shipped canvas is already on the document from `globals.css`,
 * and surfaces that gate on `hydrated` (Configure → Appearance) would otherwise
 * render their loading state forever — a lie about a lab that has no main
 * process to be waiting on.
 */
export function seedApp(): void {
  useProjectsStore.setState({ projects, selectedProjectId: project.id });
  seedBoard();
  useThemeStore.setState({
    hydrated: true,
    preview: null,
    previewAppearance: null,
    projectId: project.id,
    projectOverride: null,
  });
  useWorkspaceStore.setState({
    byProject: { [project.id]: { ...DEFAULT_WORKSPACE_UI, nav: "board" } },
    navHistory: EMPTY_NAV_HISTORY,
  });
  useUiStore.setState({
    settingsOpen: false,
    newTicketOpen: false,
    workspaceRailHidden: false,
    railCollapsed: false,
    terminalFocusTarget: null,
    uiScale: 1,
  });
  useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {}, parkState: {} });
}
