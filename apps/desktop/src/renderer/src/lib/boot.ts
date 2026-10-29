/**
 * App boot: reads the SQLite bootstrap payload, runs the one-time
 * localStorage → SQLite import on first run,
 * then hydrates the projects/board/ui/project-ui stores from it. Kept out of
 * main.tsx so the flow (envelope-unwrap, sanitization, the
 * always-clear-legacy-storage step) is unit-testable without mounting React.
 */
import { toast } from "sonner";
import { LOCAL_LAUNCH, sanitizeLegacyProjects, type CloudLaunch } from "@volli/shared";
import type {
  BootstrapPayload,
  BootstrapResult,
  DataChangeKind,
  LegacyImportRequest,
  LegacyImportResult,
  ProjectRosterResult,
} from "../../../ipc/contract";

import { seedAppStateCache } from "@renderer/lib/app-state-storage";
import { boardProtocol, startBoardProtocol } from "@renderer/lib/board-protocol";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { setBootNotice } from "@renderer/lib/boot-notice";
import {
  PROJECTS_UI_APP_STATE_KEY,
  decodeCloudSelection,
  decodeProjectsUiState,
  decodeRemoteSelection,
  encodeProjectsUiState,
  useProjectsStore,
  type CloudSelection,
} from "@renderer/stores/projects";
import { useBoardStore } from "@renderer/stores/board";
import { cloudBoardSource, installCloudBoardSource } from "@renderer/stores/board-source";
import { bindCloudAutomations } from "@renderer/stores/cloud-automations/bind";
import { CLOUD_READ_ONLY, ConvexBoardSource } from "@renderer/stores/cloud-board/source";
import {
  BOARD_SNAPSHOT_AFTER_MS,
  createSnapshotWriter,
  decodeBoardSnapshot,
  liveBoardSnapshot,
} from "@renderer/stores/cloud-board/snapshot";
import {
  followCloudWorkspace,
  useCloudWorkspaceStore,
} from "@renderer/stores/cloud-board/workspace";
import { createCloudHostSource, useCloudLinkInputs } from "@renderer/stores/cloud-link";
import {
  canWriteProject,
  hostOfProject,
  projectLinkOf,
  useHostConnectionStore,
} from "@renderer/stores/host-connection";
import { hostSurface } from "@renderer/components/hosts/host-surface-model";
import { adoptLaunch, cloudLaunchNow, launchStore } from "@renderer/stores/launch";
import { followCloudSession, startCloudClient } from "@renderer/lib/cloud-client";
import { useRemoteBoardAvailabilityStore } from "@renderer/stores/remote-board-availability";
import { followRemoteClaims, type FollowedHostStore } from "@renderer/lib/follow-remote-projects";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useThemeStore } from "@renderer/stores/theme";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkingCopyStore } from "@renderer/stores/working-copy";
import { useProjectUiStore } from "@renderer/stores/project-ui";

import { restoreRemoteSelection } from "./restore-remote-selection";
import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";

let stopSelectionRestore: (() => void) | null = null;

const LEGACY_PROJECTS_KEY = "volli:projects";
const LEGACY_UI_KEY = "volli:ui";
const LEGACY_PROJECT_UI_KEY = "volli:workspace";
const LEGACY_PREFIX = "volli:";

/** The subset of the preload API boot() needs — narrow and fake-able for tests. */
export interface BootGateway {
  bootstrap(): Promise<BootstrapResult>;
  projectRoster(input: { projectId: string }): Promise<ProjectRosterResult>;
  importLegacy(req: LegacyImportRequest): Promise<LegacyImportResult>;
}

const defaultGateway: BootGateway = {
  bootstrap: () => window.api.data.bootstrap(),
  projectRoster: (input) => window.api.data.projectRoster(input),
  importLegacy: (req) => window.api.data.importLegacy(req),
};

/**
 * Whether a change of this kind can have moved a row the board store holds.
 *
 * `comment` is the one kind that provably cannot: a comment is a row in
 * `ticket_comments`, the board holds `tickets`, and nothing on a card is
 * derived from either the comment feed or its count. Every other kind either
 * writes the ticket row (`ticket`, `worktree`, `retention`) or can move it
 * (`session` starts a Session, which moves the ticket into Doing) — and an
 * ABSENT kind is the conservative arm, because the caller could not name what
 * it changed.
 *
 * This is the VC-387 read that used to happen anyway: an agent posting one
 * comment per turn cost a full board re-read per turn, and a dozen of them
 * made a dozen. The change is still published (see the caller) — what stops is
 * the SQLite read behind it.
 */
function movesBoardData(kind: DataChangeKind | undefined): boolean {
  return kind !== "comment";
}

/** The minimal localStorage surface boot() needs — narrow enough to fake in tests. */
export interface BootStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type BootResult = { ok: true } | { ok: false; error: string };

/**
 * Rehydrates only server-owned planning data after a socket-originated mutation.
 * `change` is the `volli:data-changed` payload's scope (the affected ticket/
 * project, or `{}` for an untargeted refresh). A change naming a project the
 * board already holds reads and replaces only that project's ticket/label
 * roster. An untargeted change, one naming a project this window does not yet
 * hold, or the first board-moving change after a failed read uses bootstrap to
 * replace projects and every board slice wholesale. That successful wholesale
 * read clears recovery (`useBoardStore().planningRecoveryNeeded`), so a stale
 * board always has a healing path. Every successful path still publishes the
 * scope for per-ticket surfaces — see `useBoardStore().lastPlanningChange`.
 *
 * THE RECOVERY GUARANTEE IS RESTATED, NOT PRESERVED (VC-387). It used to be
 * "always wholesale", so any broadcast repaired any drift; what is given up is
 * that a comment no longer repairs it, because a comment no longer reads at
 * all. That repair was a side effect of the read this ticket removed — a dozen
 * agents commenting once a turn cost a dozen whole-board reads a turn — and the
 * three rules above replace it. VC-387 took the measurements.
 *
 * IT IS ALSO THE WORKING COPY BOUNDARY (VC-286). A `worktree` change is the one kind
 * that moves WHERE a ticket's Session runs — materialized, removed, recreated,
 * or a creation that failed — so the ticket's cached working copy reading is discarded
 * on the way in and read again on the way out. Both halves matter and so does
 * their order: discarding first takes the old checkout off screen at the moment
 * it stopped being true, and re-reading only after the hydrate means the new
 * reading is of the checkout the board now names. Every other kind leaves the
 * working copy alone; a comment does not move a checkout, and blanking a caption to
 * redraw the identical working copy is a flicker with nothing behind it.
 */
export async function refreshPlanningData(
  change: { ticketId?: string; projectId?: string; kind?: DataChangeKind } = {},
  gateway: Pick<BootGateway, "bootstrap" | "projectRoster"> = defaultGateway,
): Promise<BootResult> {
  // A cloud launch shows none of this Mac's database (VC-889): its board is
  // Volli Cloud's, current on its own.
  if (launchStore() === "cloud") return { ok: true };
  const movedCheckout = change.kind === "worktree";
  if (movedCheckout) useWorkingCopyStore.getState().invalidateTickets(change.ticketId);
  if (!movesBoardData(change.kind)) {
    // Nothing the board holds can have moved, so there is no read to make. The
    // signal still goes out: a comment reaches the screen through the Activity
    // feed, which refetches off `lastPlanningChange`.
    useBoardStore.getState().notePlanningChange(change);
    return { ok: true };
  }
  try {
    const projectId = change.projectId;
    if (
      !useBoardStore.getState().planningRecoveryNeeded &&
      projectId !== undefined &&
      projectId in useBoardStore.getState().ticketsByProject
    ) {
      const result = await gateway.projectRoster({ projectId });
      if (!result.ok) {
        useBoardStore.getState().notePlanningRefreshFailed();
        return result;
      }
      useBoardStore.getState().hydrateProjectRoster(projectId, result.tickets, result.labels);
      useBoardStore.getState().notePlanningChange(change);
      return { ok: true };
    }

    const result = await gateway.bootstrap();
    if (!result.ok) {
      useBoardStore.getState().notePlanningRefreshFailed();
      return result;
    }
    // `hydrate` below retires the recovery arm: the wholesale read IS the heal.
    const { projects, ticketsByProject, labelsByProject } = result.data;
    const previousSelection = useProjectsStore.getState().selectedProjectId;
    const selectedProjectId = projects.some(({ id }) => id === previousSelection)
      ? previousSelection
      : (projects[0]?.id ?? null);
    useProjectsStore.getState().hydrate(projects, selectedProjectId);
    useBoardStore.getState().hydrate(ticketsByProject, labelsByProject);
    // Signal per-ticket surfaces (the Activity feed, retention badge, Done-flow
    // rail) to refetch data not carried in the board slices — events/comments,
    // retention/git state — so a socket-originated change shows up in an
    // already-open ticket. Carries the change's scope so a surface for another
    // ticket can stand down. Published only on refresh, never at boot (surfaces
    // mount fresh there).
    useBoardStore.getState().notePlanningChange(change);
    return { ok: true };
  } catch (error) {
    // A throw is a read that did not land, exactly like an `ok: false` — the
    // board may now be missing the mutation that triggered this refresh, so the
    // next board-moving change has to go wholesale.
    useBoardStore.getState().notePlanningRefreshFailed();
    throw error;
  } finally {
    // In a `finally` because a failed hydrate is not a reason to leave a
    // discarded working copy waiting on a read nobody will make: the checkout moved
    // whatever SQLite just said about the board.
    if (movedCheckout) void useWorkingCopyStore.getState().refreshStale();
  }
}

/**
 * Follows every remote project the host-connection store claims
 * (`./follow-remote-projects`), dropping a project's board and row when its
 * claim goes.
 */
export function followRemoteProjects(
  sync: { open(projectId: string): Promise<void>; close(projectId: string): void },
  store: FollowedHostStore = useHostConnectionStore,
  alive: () => boolean = () => true,
): () => void {
  return followRemoteClaims({
    sync,
    store,
    alive,
    availability: useRemoteBoardAvailabilityStore.getState(),
    drop: (projectId) => {
      useBoardStore.getState().forget(projectId);
      useProjectsStore.getState().dropRemoteProject(projectId);
    },
  });
}

/** Whether the host has the `cloud` flag on: the Session router's experiments read. */
async function readCloudFlag(signal?: AbortSignal): Promise<boolean> {
  const experiments = await sessionRpcClient().settings.experiments.query(undefined, { signal });
  return experiments.cloud.enabled;
}

/**
 * A boot read that may not strand a fresh window before its first paint:
 * a read that fails, or takes longer than a second, answers `fallback`.
 */
async function readBeforeDeadline<Answer>(
  read: (signal: AbortSignal) => Promise<Answer>,
  fallback: Answer,
): Promise<Answer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => read(controller.signal))
        .catch(() => fallback),
      new Promise<Answer>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * With `cloud` on in a local launch, starts the board protocol's sync engine
 * for the projects a remote host serves (VC-711), each over its Workspace
 * link, as their claims arrive. This Mac's own projects stay on the legacy
 * IPC with the flag on as with it off (VC-889). With it off (or unreadable)
 * nothing starts. Resolves whether the protocol path started.
 */
export async function startBoardProtocolIfEnabled(
  readCloud: () => Promise<boolean> = readCloudFlag,
): Promise<boolean> {
  let enabled: boolean;
  try {
    enabled = await readCloud();
  } catch {
    // An unreadable flag is the default: off.
    return false;
  }
  if (!enabled) return false;
  const { sync } = startBoardProtocol({
    view: {
      paint: (projectId, tickets, labels, unloaded) =>
        useBoardStore.getState().paintBoard(projectId, tickets, labels, unloaded),
      adoptProject: (project) => useProjectsStore.getState().adoptProject(project),
      notePlanningChange: (change) => useBoardStore.getState().notePlanningChange(change),
      checkoutMoved: (ticketId) => {
        useWorkingCopyStore.getState().invalidateTickets(ticketId);
        void useWorkingCopyStore.getState().refreshStale();
      },
      failed: (message) => toastError(message),
      // Not a failure: the write keeps being sent under its id until the host answers.
      unconfirmed: (message) => toast.warning(message),
    },
  });
  // A remote project's Session listing (VC-713) is registered by its one
  // owner, the remote-Sessions binding (`bindRemoteSessionsWhileCloud`).
  // Remote projects (VC-711): each one's board over its Workspace link, for
  // the window's life.
  followRemoteProjects(sync, useHostConnectionStore, () => boardProtocol()?.sync === sync);
  return true;
}

/** Which product store this launch shows: main's answer, read once (`cloud.launch`). */
async function readCloudLaunch(signal?: AbortSignal): Promise<CloudLaunch> {
  return sessionRpcClient().cloud.launch.query(undefined, { signal });
}

/** The cloud selection the last cloud launch left, read at boot for {@link startCloudBoard}. */
let bootCloudSelection: CloudSelection | null = null;

/** What {@link startCloudBoard} reaches; tests pass their own. */
export interface CloudBoardDeps {
  start: typeof startCloudClient;
}

/**
 * The last-seen board, kept on this Mac for a launch that cannot reach
 * Volli Cloud (VC-889, D3): read once, shown by the Workspace follower if no
 * live list answers in time, and written again whenever the live board
 * settles.
 */
let stopKeepingBoard: () => void = () => {};

function cloudBoardSnapshot(userId: string, source: ConvexBoardSource) {
  // One writer per window: a second start replaces the first's.
  stopKeepingBoard();
  const timers = {
    setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const writer = createSnapshotWriter({
    read: (savedAt) =>
      useCloudWorkspaceStore.getState().projectsReady
        ? liveBoardSnapshot({
            userId,
            savedAt,
            link: useCloudLinkInputs.getState().input,
            workspace: useCloudWorkspaceStore.getState().workspace,
            projects: useProjectsStore.getState().projects,
            ticketsByProject: useBoardStore.getState().ticketsByProject,
            labelsByProject: useBoardStore.getState().labelsByProject,
            painted: (projectId) => source.painted(projectId),
          })
        : null,
    save: (text) => sessionRpcClient().cloud.saveSnapshot.mutate({ text }),
    clock: { now: () => Date.now(), ...timers },
    warn: (message, error) => console.warn(message, error),
  });
  const stops = [
    useBoardStore.subscribe((state, previous) => {
      if (
        state.ticketsByProject !== previous.ticketsByProject ||
        state.labelsByProject !== previous.labelsByProject
      ) {
        writer.schedule();
      }
    }),
    useProjectsStore.subscribe((state, previous) => {
      if (state.projects !== previous.projects) writer.schedule();
    }),
    // The board kept waits for this window's writes to be answered.
    useCloudLinkInputs.subscribe((state, previous) => {
      const now = state.input.connection?.inflightMutations ?? 0;
      const before = previous.input.connection?.inflightMutations ?? 0;
      if (now === 0 && before > 0) writer.schedule();
    }),
  ];
  stopKeepingBoard = () => {
    for (const stop of stops) stop();
  };
  return {
    afterMs: BOARD_SNAPSHOT_AFTER_MS,
    snapshot: async () => {
      try {
        const { text } = await sessionRpcClient().cloud.readSnapshot.query();
        const snapshot = decodeBoardSnapshot(text, userId);
        if (text !== null && snapshot === null)
          console.warn("the kept board snapshot is unreadable");
        return snapshot;
      } catch (error) {
        console.warn("couldn't read the board snapshot", error);
        return null;
      }
    },
    shown: (savedAt: number | null) =>
      useCloudLinkInputs.getState().update({ snapshotAt: savedAt }),
    follow: (projectId: string) => {
      source.open(projectId).catch((error: unknown) => {
        toastError(
          `Couldn’t open the board: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    ...timers,
  };
}

/**
 * A cloud launch's board (VC-889): the board source over the window's Volli
 * Cloud client, Volli Cloud's link in the host-connection store, the current
 * Workspace's projects, and then the client itself. Does nothing in a local
 * launch. Resolves whether it started; a client that could not start says so.
 */
export async function startCloudBoard(
  deps: CloudBoardDeps = { start: startCloudClient },
): Promise<boolean> {
  const launch = cloudLaunchNow();
  if (launch === null) return false;
  const source = cloudBoardSource()!;
  useHostConnectionStore.getState().attach(createCloudHostSource({ projects: useProjectsStore }));
  // The source first: a project the follower seeds opens on a running client.
  followCloudSession((session) => source.attach(session));
  const stopAutomations = bindCloudAutomations(cloudReadOnlyReason);
  window.addEventListener?.("pagehide", stopAutomations, { once: true });
  followCloudWorkspace({
    follow: followCloudSession,
    projects: useProjectsStore,
    board: useBoardStore.getState(),
    workspace: useCloudWorkspaceStore,
    persisted: bootCloudSelection,
    failed: (message) => toastError(message),
    notice: (message) => toast.warning(message),
    offline: cloudBoardSnapshot(launch.userId, source),
  });
  try {
    await deps.start(launch);
  } catch (error) {
    toastError(
      `Couldn’t start Volli Cloud: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}

/** Unwraps a zustand-persist envelope (`{state,version}`) into its `state`, or `undefined` for anything else. */
function unwrapPersistEnvelope(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (parsed as Record<string, unknown>).state;
  } catch {
    return undefined;
  }
}

/** Every `volli:*` key currently in `storage`, so `clearLegacyStorage` is exhaustive. */
function volliKeys(storage: BootStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(LEGACY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Clears every `volli:*` localStorage key — always, once bootstrap succeeds (decision #29). */
function clearLegacyStorage(storage: BootStorage): void {
  for (const key of volliKeys(storage)) storage.removeItem(key);
}

/**
 * Builds the one-time legacy import request from localStorage, or `null` when
 * there is nothing worth importing or preserving — i.e. none of
 * `volli:projects`/`volli:ui`/`volli:workspace` is present. A bare
 * `volli:board` (the old demo scaffold) is deliberately never read — decision
 * #29 discards it, and `clearLegacyStorage` sweeps it away instead.
 *
 * The request also carries `rawBackup`: every `volli:*` string, untouched, so
 * the import transaction can stash the raw source in SQLite before boot clears
 * localStorage (a lossy/unreadable import stays recoverable).
 *
 * `sourceUnreadable` flags that a `volli:projects` blob was present but yielded
 * no importable projects despite *having* project data — i.e. it was corrupt/
 * truncated, or its entries all failed validation. A cleanly-empty project
 * list (`{ projects: [] }`) is readable, just empty, and does NOT set it.
 */
function buildLegacyImportRequest(
  storage: BootStorage,
): { request: LegacyImportRequest; sourceUnreadable: boolean } | null {
  const rawProjects = storage.getItem(LEGACY_PROJECTS_KEY);
  const rawUi = storage.getItem(LEGACY_UI_KEY);
  const rawProjectUi = storage.getItem(LEGACY_PROJECT_UI_KEY);
  if (rawProjects === null && rawUi === null && rawProjectUi === null) return null;

  // The persisted `volli:projects` state is `{ projects: [...], selectedProjectId }`
  // (the old store's `partialize` shape) — sanitize the `projects` array, not
  // the envelope's `state` object itself. Absent `volli:projects` yields an
  // empty project list (a prefs-only migration), which is still worth running
  // so the ui/project-ui prefs below are carried over rather than discarded.
  const legacyState = rawProjects !== null ? unwrapPersistEnvelope(rawProjects) : undefined;
  const legacyStateRecord =
    typeof legacyState === "object" && legacyState !== null
      ? (legacyState as Record<string, unknown>)
      : undefined;
  const rawProjectsField = legacyStateRecord?.projects;
  const projects = sanitizeLegacyProjects(rawProjectsField);
  const legacySelectedId = legacyStateRecord?.selectedProjectId;

  // "Had project data we couldn't use": a present blob that either didn't parse
  // into a projects array at all, or parsed to a non-empty array none of whose
  // entries survived validation. An empty array is readable-but-empty.
  const hadProjectData = Array.isArray(rawProjectsField)
    ? rawProjectsField.length > 0
    : rawProjects !== null;
  const sourceUnreadable = hadProjectData && projects.length === 0;

  const appState: Record<string, string> = {
    [PROJECTS_UI_APP_STATE_KEY]: encodeProjectsUiState(
      typeof legacySelectedId === "string" ? legacySelectedId : null,
    ),
  };
  if (rawUi !== null) appState[LEGACY_UI_KEY] = rawUi;
  if (rawProjectUi !== null) appState[LEGACY_PROJECT_UI_KEY] = rawProjectUi;

  const rawBackup: Record<string, string> = {};
  for (const key of volliKeys(storage)) {
    const raw = storage.getItem(key);
    if (raw !== null) rawBackup[key] = raw;
  }

  return { request: { projects, appState, rawBackup }, sourceUnreadable };
}

/** The app_state-persisted selection, or `null` when absent/stale (points at a project that no longer exists). */
function resolveSelectedProjectId(
  appState: Record<string, string>,
  projects: BootstrapPayload["projects"],
): string | null {
  const id = decodeProjectsUiState(appState[PROJECTS_UI_APP_STATE_KEY]);
  return id !== null && projects.some((project) => project.id === id) ? id : null;
}

/**
 * Fire-and-forget startup nudge: runs the same orphan sweep Settings →
 * Worktrees runs on demand and surfaces ONE toast if it found anything left
 * for the user to review there — never the per-orphan detail (that's the
 * Settings list's job). Wrapped in its own try/catch (not just a `.catch` on
 * the returned promise) because `window.api` itself may be unavailable in
 * some hosts — this is a best-effort nudge and must never throw into, block,
 * or fail `boot()`.
 */
async function notifyOrphanedWorktrees(): Promise<void> {
  try {
    const result = await window.api.worktree.orphans();
    if (result.ok && result.dirty.length > 0) {
      toast.info(`${result.dirty.length} leftover worktree folder(s). See Settings.`);
    }
  } catch {
    // Best-effort only — swallow silently.
  }
}

/**
 * Runs the full boot sequence: bootstrap SQLite, one-time legacy import on
 * first run, then hydrates the projects/board/ui/project-ui stores. Returns
 * `{ ok: false }` only when `bootstrap()` itself fails — main.tsx renders the
 * DB-failure empty state in that case instead of mounting the app.
 */
export async function boot(
  gateway: BootGateway = defaultGateway,
  storage: BootStorage = localStorage,
  readCloud: (signal: AbortSignal) => Promise<boolean> = readCloudFlag,
  readLaunch: (signal: AbortSignal) => Promise<CloudLaunch> = readCloudLaunch,
): Promise<BootResult> {
  stopSelectionRestore?.();
  stopSelectionRestore = null;
  const bootstrapResult = await gateway.bootstrap();
  if (!bootstrapResult.ok) return bootstrapResult;

  let payload = bootstrapResult.data;

  // Attempt the one-time legacy import whenever the projects table is still
  // empty and localStorage holds legacy data. Gating on projects-emptiness
  // alone (NOT the old `firstRun`, which also required app_state to be empty)
  // is what makes a transient import failure retriable: normal UI use writes
  // app_state, which used to flip `firstRun` false and both skip the pending
  // import AND destroy its source on the next boot. The main handler is itself
  // idempotent (it no-ops once projects exist), so re-attempting is safe.
  let preserveSource = false;
  if (payload.projects.length === 0) {
    const built = buildLegacyImportRequest(storage);
    if (built !== null) {
      const importResult = await gateway.importLegacy(built.request);
      if (!importResult.ok) {
        // A failed import rolled back its transaction — nothing was persisted,
        // not even the backup, so the localStorage source is the only copy.
        // Keep it for a retry next launch and surface the failure (CLAUDE.md:
        // never silently swallow a failed mutation). The Toaster isn't mounted
        // yet, so stash the message; AppShell surfaces it on mount.
        preserveSource = true;
        setBootNotice(
          `Couldn't import your existing data (${importResult.error}). Nothing was changed. Relaunch to try again.`,
        );
      } else {
        payload = importResult.data;
        // A present-but-unreadable `volli:projects` blob imported nothing (the
        // authoritative `imported` count confirms it). The import transaction
        // already backed up the raw source into SQLite, so clearing localStorage
        // below is safe — but tell the user their data couldn't be read rather
        // than discarding it silently.
        if (built.sourceUnreadable && importResult.imported === 0) {
          setBootNotice("Found project data we couldn't read. It's backed up, not imported.");
        }
      }
    }
  }

  // Clear the legacy localStorage once we've booted (decision #29) — a clean
  // (or zero-project, already-backed-up) import discards it, as does a boot
  // with nothing importable. The one exception is a failed import, handled
  // above: never destroy the source when nothing was persisted in its place.
  if (!preserveSource) clearLegacyStorage(storage);

  seedAppStateCache(payload.appState);

  // The canvas and the appearance, straight off the `app_state` rows the
  // bootstrap already carries — BEFORE the projects store hydrates, because
  // that hydrate announces the restored project and the theme store resolves
  // a project override against the global canvas this line installs.
  useThemeStore.getState().hydrateGlobal(payload.appState);

  // Resolved BEFORE hydrate (rather than hydrating with `null` and calling
  // `select` afterward) so boot never fires a redundant appState.set — the
  // value already came FROM app_state, there's nothing new to persist.
  const cloud = await readBeforeDeadline(readCloud, false);
  // Main chooses the product store, independently of hosted-cloud capabilities.
  // An embedded deployment can use Convex without enabling the cloud flag.
  // This local bridge reads no account; stalled/older bridges fall back to SQLite.
  const launch = await readBeforeDeadline(readLaunch, LOCAL_LAUNCH);
  adoptLaunch(launch);
  const selectedProjectId = resolveSelectedProjectId(payload.appState, payload.projects);
  if (launch.store === "cloud") {
    return bootCloudLaunch(launch, payload, selectedProjectId);
  }
  const remote = cloud ? decodeRemoteSelection(payload.appState[PROJECTS_UI_APP_STATE_KEY]) : null;
  // The last cloud launch's selection survives this launch's own (VC-889).
  useProjectsStore
    .getState()
    .keepCloudSelection(decodeCloudSelection(payload.appState[PROJECTS_UI_APP_STATE_KEY]));
  useProjectsStore.setState({ pendingRemoteSelection: null });
  useProjectsStore
    .getState()
    .hydrate(
      payload.projects,
      remote === null ? selectedProjectId : (selectedProjectId ?? payload.projects[0]?.id ?? null),
    );
  if (remote !== null) useProjectsStore.getState().beginRemoteRestore(remote);
  useBoardStore.getState().hydrate(payload.ticketsByProject, payload.labelsByProject);

  // The theme store is deliberately absent: it has no `persist` middleware and
  // nothing of its own in localStorage. Every value it holds comes from SQLite —
  // the `app_state` rows adopted above, the `projects` columns the scope
  // listener hands it, and `volli:theme-state` for the terminal chain.
  await Promise.all([
    useUiStore.persist.rehydrate(),
    useProjectUiStore.persist.rehydrate(),
    useChatDraftsStore.persist.rehydrate(),
  ]);
  // Typed provisional Drafts are the one chat kind whose identity lives in
  // app_state rather than the Session listing. Reopen their tabs only after
  // both the Drafts and project UI layout have landed, so recorded `chat:<id>`
  // values resolve normally on the app's first render.
  useChatSessionsStore
    .getState()
    .restoreProvisionalChatTabs(
      useChatDraftsStore.getState().drafts,
      new Set(
        Object.values(payload.ticketsByProject).flatMap((tickets) => tickets.map(({ id }) => id)),
      ),
      new Set(payload.projects.map(({ id }) => id)),
    );

  if (remote !== null) {
    const stop = restoreRemoteSelection({
      selection: remote,
      hosts: useHostConnectionStore,
      projects: useProjectsStore,
      failed: (message) => toast.warning(message),
    });
    // Boot owns the wait, not a component effect: StrictMode cannot restart its deadline.
    const cleanups: (() => void)[] = [stop];
    const dispose = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      window.removeEventListener?.("pagehide", dispose);
    };
    cleanups.push(
      useExperimentsStore.subscribe((state) => {
        if (state.snapshot !== null && !isExperimentOn(state.snapshot, "cloud")) {
          useProjectsStore.getState().cancelRemoteRestore();
        }
      }),
    );
    cleanups.push(
      useProjectsStore.subscribe((state) => {
        if (state.pendingRemoteSelection !== remote) dispose();
      }),
    );
    stopSelectionRestore = dispose;
    window.addEventListener?.("pagehide", dispose, { once: true });
    if (useProjectsStore.getState().pendingRemoteSelection !== remote) dispose();
  }

  // Fire-and-forget — never awaited, so it can't delay the app's first paint,
  // and its own try/catch means it can't fail boot either.
  void notifyOrphanedWorktrees();

  return { ok: true };
}

/** Why a cloud project cannot be written to now, in its link's words, or `null` when it can. */
function cloudReadOnlyReason(projectId: string): string | null {
  const state = useHostConnectionStore.getState();
  if (canWriteProject(state, projectId)) return null;
  const host = hostOfProject(state, projectId);
  return hostSurface({ ...host, link: projectLinkOf(state, projectId) }, Date.now())!.line;
}

/**
 * The rest of a cloud launch's boot (VC-889): this Mac's projects and boards
 * are not hydrated (Volli Cloud's arrive with the client, `startCloudBoard`);
 * only their count is kept, for the rail's footer, and the local and remote
 * selections stay as they were for the next local launch. The window's own
 * preferences restore as always.
 */
async function bootCloudLaunch(
  launch: Extract<CloudLaunch, { store: "cloud" }>,
  payload: BootstrapPayload,
  localSelection: string | null,
): Promise<BootResult> {
  const raw = payload.appState[PROJECTS_UI_APP_STATE_KEY];
  // A just-joined Workspace or moved project is a one-launch navigation intent.
  // Main never writes this store's persisted selection shape.
  bootCloudSelection =
    launch.joinedWorkspaceId === undefined
      ? decodeCloudSelection(raw)
      : { workspaceId: launch.joinedWorkspaceId, projectId: launch.openProjectId ?? null };
  useProjectsStore.setState({ pendingRemoteSelection: null });
  useProjectsStore
    .getState()
    .beginCloudLaunch({ local: localSelection, remote: decodeRemoteSelection(raw) });
  useCloudWorkspaceStore.setState({ localProjects: payload.projects.length });
  // Every board write of this launch goes to Volli Cloud's source from the
  // first frame, never to this Mac's database, even before its client runs.
  const source = new ConvexBoardSource(
    {
      paint: (projectId, tickets, labels, unloaded) =>
        useBoardStore.getState().paintBoard(projectId, tickets, labels, unloaded),
      notePlanningChange: (change) => useBoardStore.getState().notePlanningChange(change),
      failed: (message) => toastError(message),
      refused: (message) => toast(message, { id: "host-read-only" }),
      unconfirmed: (message) => toast.warning(message, { id: "cloud-unconfirmed" }),
      readOnly: (projectId) =>
        projectId !== undefined
          ? cloudReadOnlyReason(projectId)
          : useCloudLinkInputs.getState().input.snapshotAt !== null
            ? CLOUD_READ_ONLY
            : null,
      dropped: (projectId, message, code) => {
        const project = useProjectsStore.getState().projects.find(({ id }) => id === projectId);
        useBoardStore.getState().forget(projectId);
        useProjectsStore.getState().dropRemoteProject(projectId);
        // The Workspace follower owns the single membership-loss notice.
        if (code !== "not_a_member")
          toast.warning(`${project?.name ?? "A project"} isn’t available any more: ${message}`);
      },
    },
    launch.userId,
  );
  installCloudBoardSource(source);
  await Promise.all([
    useUiStore.persist.rehydrate(),
    useProjectUiStore.persist.rehydrate(),
    useChatDraftsStore.persist.rehydrate(),
  ]);
  // A provisional Draft belongs to one of this Mac's tickets or projects,
  // none of which this launch shows: it is not reopened, and stays saved for
  // the next local launch.
  return { ok: true };
}
