/**
 * The unified terminal-session store: ONE resident model for both project
 * scratch sessions (CONTEXT.md's "Scratch session") and ticket-scoped sessions
 * (ticket-detail-mvp decision #19). Every tab carries a {@link SessionScope}
 * discriminator; the always-mounted sessions layer reads it to route each live
 * terminal to its surface (the Sessions page for scratch, a rect-synced overlay
 * over the ticket plane for ticket sessions). Both scopes get the full split
 * tree, activity tracking, and rename.
 *
 * A split leaf is the ownership boundary: exactly one renderer engine and one
 * main-process PTY session. Layout nodes own geometry only. This mirrors
 * Ghostty/cmux, where a split inserts a fresh terminal surface instead of
 * asking one renderer instance to paint the same PTY into another canvas.
 *
 * Containers live in `byOwner`, keyed by the scope's OWNER id — a projectId for
 * scratch, a ticketId for ticket sessions (distinct UUID spaces, so one flat
 * map never collides). Cross-cutting, sessionId-addressed actions (markExited,
 * bumpOutput, renameSession) route through the `sessionOwner` index so the
 * per-chunk hot path stays O(1).
 */
import { create } from "zustand";
import {
  createSessionHarnessState,
  getHarnessAdapter,
  harnessTier,
  HARNESS_EVENTS,
  receiveHarnessEvent,
  supportedEvents,
  type CreateSessionHarnessStateInput,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessEventOrder,
  type HarnessId,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionRecord,
} from "@volli/shared";

import { useTicketSessionRecordsStore } from "./ticket-session-records";

export type TerminalSplitDirection = "vertical" | "horizontal";

/**
 * What a session is scoped to, stamped on every tab. `scratch` runs at the
 * project's main checkout with no board involvement; `ticket` is ticket-scoped
 * (env-injected PTY in main) and hosts in the ticket detail's tab plane. Both
 * carry `projectId` so a split can re-boot its PTY (cwd + optional ticket env)
 * without another lookup.
 */
export type SessionScope =
  | { kind: "scratch"; projectId: string }
  | { kind: "ticket"; projectId: string; ticketId: string };

/** The container key for a scope: projectId for scratch, ticketId for ticket. */
export function ownerKey(scope: SessionScope): string {
  return scope.kind === "scratch" ? scope.projectId : scope.ticketId;
}

/** A project's scratch-session scope. */
export function scratchScope(projectId: string): SessionScope {
  return { kind: "scratch", projectId };
}

/** A ticket's session scope. */
export function ticketScope(projectId: string, ticketId: string): SessionScope {
  return { kind: "ticket", projectId, ticketId };
}

export interface SessionPane {
  kind: "pane";
  sessionId: string;
  /** null while the pane's PTY is live; the shell's exit code once exited. */
  exitCode: number | null;
}

export interface SessionSplit {
  kind: "split";
  /** Stable identity for resizing this layout node. */
  id: string;
  /** vertical = left/right; horizontal = top/bottom (restty/Ghostty naming). */
  direction: TerminalSplitDirection;
  ratio: number;
  first: SessionLayout;
  second: SessionLayout;
}

export type SessionLayout = SessionPane | SessionSplit;

export interface SessionTab {
  /** The root pane's session id is also the stable tab id and the durable record id. */
  sessionId: string;
  title: string;
  /** Where this session lives (scratch vs ticket) — the layer routes rendering off this. */
  scope: SessionScope;
  layout: SessionLayout;
  activePaneId: string;
}

export interface SessionContainer {
  tabs: SessionTab[];
  activeSessionId: string | null;
}

/**
 * What a landing tab knows about the process main just spawned for it. Main is
 * the only party that can say whether a harness command line was actually
 * written into that shell (`launchKind`), which harness it named
 * (`harnessId`), and when the process really started (`createdAt`) — and it
 * already hands the whole durable {@link SessionRecord} back from
 * `terminal.create`. The store takes this slice of it rather than a bare title
 * so that knowledge survives the trip: the boot pipeline used to read
 * `session.title` off the record and drop the rest on the floor, which is why
 * nothing in the shipped app ever declared a harness expectation and the
 * degradation tier below was unreachable outside tests.
 *
 * `createdAt` rides along instead of being stamped at landing time: the grace
 * window for a first event is measured from the launch, and a slow boot would
 * otherwise silently shorten it.
 */
export type SessionLaunch = Pick<SessionRecord, "title" | "harnessId" | "launchKind" | "createdAt">;

/** Output within this window reads as `working`; quiet-but-live reads as `idle`. */
const WORKING_WINDOW_MS = 10_000;
/** Coalesce output bumps: at most one `lastOutputAt` write per session per second. */
const OUTPUT_THROTTLE_MS = 1_000;

/**
 * Honest session status (ticket-detail-mvp decision #5): `working` when output
 * landed within ~10s, `idle` when live but quiet, `parked` when the warm-park
 * tier has SIGSTOP'd the session's process tree to reclaim memory (decision
 * #32), `exited` once the shell is gone.
 *
 * Precedence, outside in. `exited` wins over everything (a parked pane can't
 * come back exited, but the check order keeps the derivation defensive), then
 * `parked` — both are facts about the process, and no hook payload outranks the
 * process being stopped or gone. Then `declared`, the harness's own word for
 * what it is doing, which beats output recency because recency is a proxy and
 * the hook is the thing itself: an agent blocked at a permission prompt emits
 * nothing, so derivation reads it as `idle` — exactly backwards. Absent a
 * declared state the original output-recency derivation is unchanged.
 *
 * `declared` is deliberately required rather than defaulting to `null`. It once
 * defaulted, and the ticket detail's session rail simply never passed it — so
 * that surface silently reported a blocked agent as `idle` while the sidebar,
 * reading the same session, said "Waiting for you". A default turns forgetting
 * the harness's own report into a plausible wrong answer; requiring it turns
 * the same mistake into a compile error.
 *
 * Pure and clock-injected, so every rung is unit-testable.
 */
export function sessionActivityState(
  lastOutputAt: number | null,
  exited: boolean,
  now: number,
  parked: boolean,
  declared: SessionActivityState | null,
): SessionActivityState {
  if (exited) return "exited";
  if (parked) return "parked";
  if (declared !== null) return declared;
  if (lastOutputAt !== null && now - lastOutputAt <= WORKING_WINDOW_MS) return "working";
  return "idle";
}

interface SessionsState {
  /** Session containers keyed by owner id (projectId for scratch, ticketId for ticket). */
  byOwner: Record<string, SessionContainer>;
  /** sessionId → owning container key; the O(1) routing index for the hot path and rename. */
  sessionOwner: Record<string, string>;
  /** sessionId → last PTY-output time (ms) — feeds the working/idle derivation for all sessions. */
  lastOutputAt: Record<string, number>;
  /**
   * sessionId → warm-park state (decision #32): `parked` mirrors main's SIGSTOP
   * on the session's process tree, `keepAwake` mirrors the user's exclusion pin
   * against auto-park. Pushed by `onParkState` on every park/wake/pin change.
   */
  parkState: Record<string, { parked: boolean; keepAwake: boolean }>;
  /**
   * sessionId → what that session's harness has actually reported. Present for
   * sessions {@link SessionsState.addSession} registered at launch, plus any a
   * delivered event registered on arrival; an absent entry means "nothing is
   * reporting here", which is the honest default and what every bare shell and
   * every pre-existing session already looks like.
   */
  harness: Record<string, SessionHarnessState>;
  /** Owner ids with a terminal-create (tab or split leaf) in flight — disables their "New session". */
  starting: Record<string, true>;
  /**
   * Lands a freshly booted PTY as a single-pane tab, titled and — when the
   * launch was an agent kickoff or resume — registered with what its harness is
   * expected to report. `launch` is the durable record's own account of the
   * spawn rather than a caller-assembled one, and it is required rather than
   * optional for the reason `declared` is required on
   * {@link sessionActivityState}: a defaulted expectation would make "the
   * harness isn't reporting" and "a caller forgot to say" the same observation,
   * and that is precisely the confusion this state exists to remove.
   */
  addSession(scope: SessionScope, sessionId: string, launch: SessionLaunch): void;
  /**
   * Insert a fresh PTY/engine as a sibling of sourcePaneId. It takes no
   * {@link SessionLaunch} because a split never carries one: nothing in the app
   * can kick an agent off into a split, so main stamps every split record
   * `shell`, and a bare shell has no harness expectation to declare.
   */
  addSplit(
    ownerId: string,
    tabId: string,
    sourcePaneId: string,
    sessionId: string,
    direction: TerminalSplitDirection,
  ): void;
  closeSession(ownerId: string, tabId: string): void;
  closePane(ownerId: string, tabId: string, sessionId: string): void;
  setActiveSession(ownerId: string, tabId: string): void;
  setActivePane(ownerId: string, tabId: string, sessionId: string): void;
  setSplitRatio(ownerId: string, tabId: string, splitId: string, ratio: number): void;
  /** Optimistically retitle a tab (its persistence + revert-on-failure lives in session-lifecycle). */
  renameSession(sessionId: string, title: string): void;
  markExited(sessionId: string, exitCode: number): void;
  bumpOutput(sessionId: string, now: number): void;
  /** Records a warm-park push from main; sourced from `window.api.terminal.onParkState`. */
  setParkState(sessionId: string, parked: boolean, keepAwake: boolean): void;
  /**
   * Registers what a session's harness is expected to report, before it has
   * produced a byte. The expectation is what makes silence legible later:
   * without it, a wrapper that was bypassed is indistinguishable from a harness
   * that never had hooks. {@link SessionsState.addSession} calls it for every
   * agent launch; {@link subscribeHarnessEvents} calls it for the reporting
   * sessions a launch could not have known about.
   */
  expectHarnessEvents(sessionId: string, input: CreateSessionHarnessStateInput): void;
  /**
   * Folds one canonical harness event pushed from main onto that session's
   * state. `firedAt` is the ordering key the delivery carried — required, not
   * defaulted, for the reason `declared` is: events arrive on racing hook
   * processes, so a caller that quietly omitted it would put the store back on
   * arrival order, which is the defect and not a degradation of it.
   */
  applyHarnessEvent(sessionId: string, event: HarnessEvent, firedAt: HarnessEventOrder): void;
  /**
   * Moves a session's harness state onto the harness that just announced itself
   * from inside that terminal (`volli session harness`, pushed by main).
   *
   * A REPLACEMENT rather than an edit of `harnessId`, because everything else in
   * the state belongs to the harness it was about: the tier and the declared
   * events are the previous adapter's, `delivered` is its delivery record, and
   * `declared` is its word for what it was doing. A `waiting` raised by an agent
   * the user has since quit is the exact stale-needs-you the sidebar must not
   * keep showing. The grace window restarts too — this harness has only just
   * started, and has had no time to report.
   *
   * A replacement EVEN WHEN the harness announced is the one already believed to
   * be running, which is not idempotence thrown away but the point: an announce
   * is a launch, and a relaunch of the same harness in the same terminal is a
   * fresh channel that has proved nothing. Keeping the previous launch's
   * `delivered` there is how a quit-and-restart inherited a reputation it had
   * not earned.
   */
  announceHarness(sessionId: string, harnessId: HarnessId, at: number): void;
  setStarting(ownerId: string, starting: boolean): void;
  forgetOwner(ownerId: string): void;
}

const EMPTY_CONTAINER: SessionContainer = { tabs: [], activeSessionId: null };

export function sessionPanes(layout: SessionLayout): SessionPane[] {
  return layout.kind === "pane"
    ? [layout]
    : [...sessionPanes(layout.first), ...sessionPanes(layout.second)];
}

export function findSessionPane(layout: SessionLayout, sessionId: string): SessionPane | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? layout : null;
  return findSessionPane(layout.first, sessionId) ?? findSessionPane(layout.second, sessionId);
}

/** The owning container key + tab for a tab's root sessionId, or null. Reads across every owner. */
export function findTabBySessionId(
  byOwner: Record<string, SessionContainer>,
  sessionId: string,
): { ownerId: string; tab: SessionTab } | null {
  for (const [ownerId, container] of Object.entries(byOwner)) {
    const tab = container.tabs.find((candidate) => candidate.sessionId === sessionId);
    if (tab !== undefined) return { ownerId, tab };
  }
  return null;
}

function replacePaneWithSplit(
  layout: SessionLayout,
  sourcePaneId: string,
  sessionId: string,
  direction: TerminalSplitDirection,
): SessionLayout {
  if (layout.kind === "pane") {
    if (layout.sessionId !== sourcePaneId) return layout;
    return {
      kind: "split",
      id: sessionId,
      direction,
      ratio: 0.5,
      first: layout,
      second: { kind: "pane", sessionId, exitCode: null },
    };
  }
  const first = replacePaneWithSplit(layout.first, sourcePaneId, sessionId, direction);
  if (first !== layout.first) return { ...layout, first };
  const second = replacePaneWithSplit(layout.second, sourcePaneId, sessionId, direction);
  return second === layout.second ? layout : { ...layout, second };
}

function removePane(layout: SessionLayout, sessionId: string): SessionLayout | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? null : layout;
  const first = removePane(layout.first, sessionId);
  const second = removePane(layout.second, sessionId);
  if (first === null) return second;
  if (second === null) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

function updateSplitRatio(layout: SessionLayout, splitId: string, ratio: number): SessionLayout {
  if (layout.kind === "pane") return layout;
  if (layout.id === splitId) return { ...layout, ratio };
  const first = updateSplitRatio(layout.first, splitId, ratio);
  const second = updateSplitRatio(layout.second, splitId, ratio);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

function updateExitCode(layout: SessionLayout, sessionId: string, exitCode: number): SessionLayout {
  if (layout.kind === "pane") {
    return layout.sessionId === sessionId ? { ...layout, exitCode } : layout;
  }
  const first = updateExitCode(layout.first, sessionId, exitCode);
  const second = updateExitCode(layout.second, sessionId, exitCode);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Drop every one of a tab's pane sessions from the routing + activity + park indexes. */
function forgetTabIndexes(
  sessionOwner: Record<string, string>,
  lastOutputAt: Record<string, number>,
  parkState: Record<string, { parked: boolean; keepAwake: boolean }>,
  harness: Record<string, SessionHarnessState>,
  tab: SessionTab,
): void {
  for (const pane of sessionPanes(tab.layout)) {
    delete sessionOwner[pane.sessionId];
    delete lastOutputAt[pane.sessionId];
    delete parkState[pane.sessionId];
    delete harness[pane.sessionId];
  }
  // Also clear the tab-root routing entry: `closePane` deliberately RETAINS
  // `sessionOwner[tab.sessionId]` when the root pane is closed (the id stays the
  // tab's stable identity for rename/routing), so the root id may no longer be
  // among the current panes above — drop it explicitly on tab teardown.
  delete sessionOwner[tab.sessionId];
  delete lastOutputAt[tab.sessionId];
  delete parkState[tab.sessionId];
  delete harness[tab.sessionId];
}

interface HarnessCatalogState {
  /**
   * The registered harnesses main last said it would launch — never the
   * built-ins, which are compiled in. Empty before the first answer arrives,
   * and empty is indistinguishable from "none registered" ON PURPOSE: both mean
   * this renderer knows nothing about any harness beyond the four it ships, and
   * every reader here already has a correct behaviour for that.
   */
  registered: readonly HarnessAdapter[];
  setRegistered(registered: readonly HarnessAdapter[]): void;
}

/**
 * What the renderer knows about harnesses it does not ship.
 *
 * A trusted manifest exists in exactly one place — main, which read the file,
 * hashed it and reconciled it against the user's recorded verdict — so this is
 * a mirror and never a source. It is pulled rather than pushed, and pulled
 * fresh at the two moments it could be wrong: app start, and every open of a
 * surface that offers a harness. That is the same shape the trust queue uses
 * (`components/harness/trust-prompt-model.ts` re-reads after every verdict)
 * rather than a second, push-shaped one, and it is what keeps the mirror honest
 * across a verdict recorded mid-session: trusting a harness now regenerates the
 * wrappers on the spot, so the catalog genuinely moves while the app is open.
 */
export const useHarnessCatalogStore = create<HarnessCatalogState>()((set) => ({
  registered: [],
  setRegistered: (registered) => set({ registered }),
}));

/**
 * Re-reads the registered harnesses from main. A failed read leaves the last
 * good answer standing rather than emptying the catalog: the failure mode of
 * forgetting a harness (a picker entry vanishing, a live launch losing its
 * expectation) is worse than the failure mode of a stale entry, which the
 * launch door refuses anyway.
 */
export async function hydrateHarnessCatalog(): Promise<void> {
  const result = await window.api.harness.registered();
  if (!result.ok) return;
  useHarnessCatalogStore.getState().setRegistered(result.harnesses);
}

/**
 * The adapter behind a harness id: a built-in, or a registered one the catalog
 * has heard about. `undefined` means neither — an id this renderer cannot
 * describe, which every caller has to answer for itself.
 */
export function launchAdapter(harnessId: HarnessId): HarnessAdapter | undefined {
  return (
    getHarnessAdapter(harnessId) ??
    useHarnessCatalogStore.getState().registered.find((adapter) => adapter.id === harnessId)
  );
}

/**
 * The harness expectation a launch earns, or null when it earns none.
 *
 * Only an `agent` launch earns one. Volli wrote that command line itself,
 * through its own wrapper, so silence on the channel afterwards is a fact
 * about the wrapper — a stale PATH, a `volli doctor --fix` never run — and
 * worth saying out loud. A bare shell promised nothing: every split, every
 * ticket tab opened without a kickoff, every scratch terminal must be able to
 * sit quietly for an hour without the sidebar accusing it of not reporting.
 *
 * A registered harness now earns one too, off the catalog: its manifest states
 * its bindings, so the expectation is read rather than guessed, and a trusted
 * harness that stops reporting decays into "not reporting" exactly as a
 * built-in does. Only a harness NOTHING here can describe still earns none —
 * the catalog not hydrated yet, an id trusted after this renderer last asked.
 * A guess there would go wrong in both directions: claim `hooked` and a
 * perfectly working harness gets called silent, claim less and we vouch for
 * events it may not send. Its first delivery registers it instead — see
 * {@link subscribeHarnessEvents}.
 *
 * The expectation is stated here but its CLOCK does not start here, which is
 * why `startedAt` is null. This is the PTY spawning a login shell; the harness
 * is a command that shell has not run yet, and counting silence from this
 * moment timed how long the user took to type. `announceHarness` sets the
 * anchor when the wrapper calls in, and until it does, this session is expected
 * to report but is not yet owed anything.
 */
function launchExpectation(launch: SessionLaunch): SessionHarnessState | null {
  if (launch.launchKind !== "agent") return null;
  const adapter = launchAdapter(launch.harnessId);
  if (adapter === undefined) return null;
  return createSessionHarnessState({
    harnessId: launch.harnessId,
    expectedTier: harnessTier(adapter),
    declaredEvents: [...supportedEvents(adapter)],
    startedAt: null,
  });
}

/** Factory so tests get isolated instances. */
export function createSessionsStore() {
  return create<SessionsState>()((set) => ({
    byOwner: {},
    sessionOwner: {},
    lastOutputAt: {},
    parkState: {},
    harness: {},
    starting: {},

    addSession(scope, sessionId, launch) {
      set((state) => {
        const id = ownerKey(scope);
        const current = state.byOwner[id] ?? EMPTY_CONTAINER;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tab: SessionTab = {
          sessionId,
          title: launch.title,
          scope,
          layout: { kind: "pane", sessionId, exitCode: null },
          activePaneId: sessionId,
        };
        // Declared here rather than by the caller, and in the same write that
        // lands the tab: this is the one moment the app both knows a hooked
        // harness was kicked off and owns the state that has to remember it,
        // so the expectation cannot be forgotten at one launch site and honored
        // at another.
        const expectation = launchExpectation(launch);
        return {
          byOwner: {
            ...state.byOwner,
            [id]: { tabs: [...current.tabs, tab], activeSessionId: sessionId },
          },
          sessionOwner: { ...state.sessionOwner, [sessionId]: id },
          harness:
            expectation === null ? state.harness : { ...state.harness, [sessionId]: expectation },
        };
      });
    },

    addSplit(ownerId, tabId, sourcePaneId, sessionId, direction) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || findSessionPane(tab.layout, sourcePaneId) === null) return state;
        const layout = replacePaneWithSplit(tab.layout, sourcePaneId, sessionId, direction);
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout, activePaneId: sessionId };
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } },
          sessionOwner: { ...state.sessionOwner, [sessionId]: ownerId },
        };
      });
    },

    closeSession(ownerId, tabId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const removedIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        if (removedIndex === -1) return state;
        const removed = current.tabs[removedIndex]!;
        const tabs = current.tabs.filter((tab) => tab.sessionId !== tabId);
        let activeSessionId = current.activeSessionId;
        if (activeSessionId === tabId) {
          activeSessionId =
            tabs.length === 0 ? null : tabs[Math.min(removedIndex, tabs.length - 1)]!.sessionId;
        }
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        const parkState = { ...state.parkState };
        const harness = { ...state.harness };
        forgetTabIndexes(sessionOwner, lastOutputAt, parkState, harness, removed);
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs, activeSessionId } },
          sessionOwner,
          lastOutputAt,
          parkState,
          harness,
        };
      });
    },

    closePane(ownerId, tabId, sessionId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const before = sessionPanes(tab.layout);
        const removedIndex = before.findIndex((pane) => pane.sessionId === sessionId);
        if (removedIndex === -1 || before.length <= 1) return state;
        // A known leaf in a 2+ pane tree cannot remove the whole tree.
        const layout = removePane(tab.layout, sessionId)!;
        const remaining = sessionPanes(layout);
        const activePaneId =
          tab.activePaneId === sessionId
            ? remaining[Math.min(removedIndex, remaining.length - 1)]!.sessionId
            : tab.activePaneId;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout, activePaneId };
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        const parkState = { ...state.parkState };
        const harness = { ...state.harness };
        // `lastOutputAt`/`parkState`/`harness` are keyed per-pane, so the closed
        // pane's entries always go — it can no longer produce output, be parked,
        // or have a harness reporting on its behalf.
        delete lastOutputAt[sessionId];
        delete parkState[sessionId];
        delete harness[sessionId];
        // `sessionOwner` routes rename/exit lookups. Asymmetry: when the closed
        // pane IS the tab root (sessionId === tabId), the tab keeps that id as
        // its stable identity — rename/routing still resolve through it — so we
        // must NOT drop its routing entry here, or a later rename would silently
        // no-op while the DB write lands (UI/SQLite titles diverge). Only a
        // non-root pane's entry is dropped now; the retained root entry is
        // cleared by `forgetTabIndexes` when the whole tab closes.
        if (sessionId !== tabId) delete sessionOwner[sessionId];
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } },
          sessionOwner,
          lastOutputAt,
          parkState,
          harness,
        };
      });
    },

    setActiveSession(ownerId, tabId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === tabId)) {
          return state;
        }
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, activeSessionId: tabId } },
        };
      });
    },

    setActivePane(ownerId, tabId, sessionId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || findSessionPane(tab.layout, sessionId) === null) return state;
        if (tab.activePaneId === sessionId) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, activePaneId: sessionId };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    setSplitRatio(ownerId, tabId, splitId, ratio) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const clamped = Math.min(0.9, Math.max(0.1, ratio));
        const layout = updateSplitRatio(tab.layout, splitId, clamped);
        if (layout === tab.layout) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    renameSession(sessionId, title) {
      set((state) => {
        const ownerId = state.sessionOwner[sessionId];
        if (ownerId === undefined) return state;
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === sessionId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || tab.title === title) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, title };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    markExited(sessionId, exitCode) {
      set((state) => {
        const ownerId = state.sessionOwner[sessionId];
        if (ownerId === undefined) return state;
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex(
          (tab) => findSessionPane(tab.layout, sessionId) !== null,
        );
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout: updateExitCode(tab.layout, sessionId, exitCode) };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    bumpOutput(sessionId, now) {
      set((state) => {
        // Hot path: runs for EVERY chunk of EVERY live session. The O(1)
        // ownership lookup gates first (an unknown/closed session early-returns
        // for free), then the ≥1s throttle, and only then a state write.
        if (!(sessionId in state.sessionOwner)) return state;
        const last = state.lastOutputAt[sessionId] ?? 0;
        if (now - last < OUTPUT_THROTTLE_MS) return state;
        return { lastOutputAt: { ...state.lastOutputAt, [sessionId]: now } };
      });
    },

    setParkState(sessionId, parked, keepAwake) {
      set((state) => {
        // A late push for a closed session must not resurrect its entry:
        // kill() wakes a parked tree before killing it, and that wake's
        // park-state event lands after the renderer already forgot the id.
        if (!(sessionId in state.sessionOwner)) return state;
        const current = state.parkState[sessionId];
        if (current !== undefined && current.parked === parked && current.keepAwake === keepAwake) {
          return state;
        }
        return { parkState: { ...state.parkState, [sessionId]: { parked, keepAwake } } };
      });
    },

    expectHarnessEvents(sessionId, input) {
      set((state) => {
        // Same late-push guard the park pushes carry: a launch that lost its
        // race with a close must not leave a live-looking entry behind.
        if (!(sessionId in state.sessionOwner)) return state;
        return { harness: { ...state.harness, [sessionId]: createSessionHarnessState(input) } };
      });
    },

    applyHarnessEvent(sessionId, event, firedAt) {
      set((state) => {
        const current = state.harness[sessionId];
        if (current === undefined) return state;
        // Supersession lives in `receiveHarnessEvent`, not here: main applies
        // the same shared rule before it writes, and a second definition of
        // stale on this side is exactly how the two ends would come to disagree
        // about whether a session is waiting.
        return {
          harness: { ...state.harness, [sessionId]: receiveHarnessEvent(current, event, firedAt) },
        };
      });
    },

    announceHarness(sessionId, harnessId, at) {
      set((state) => {
        // The same late-push guard the park pushes carry.
        if (!(sessionId in state.sessionOwner)) return state;
        const adapter = launchAdapter(harnessId);
        // Nothing here can describe it (a harness trusted since this renderer
        // last asked the catalog), so there is no honest expectation to state —
        // the same silence {@link launchExpectation} keeps, and for the same
        // reason: guessing goes wrong in both directions. Its first delivered
        // event registers it, exactly as an unknown launch's does.
        if (adapter === undefined) return state;
        return {
          harness: {
            ...state.harness,
            [sessionId]: createSessionHarnessState({
              harnessId,
              expectedTier: harnessTier(adapter),
              declaredEvents: [...supportedEvents(adapter)],
              startedAt: at,
            }),
          },
        };
      });
    },

    setStarting(ownerId, starting) {
      set((state) => {
        const isStarting = ownerId in state.starting;
        if (starting === isStarting) return state;
        const next = { ...state.starting };
        if (starting) next[ownerId] = true;
        else delete next[ownerId];
        return { starting: next };
      });
    },

    forgetOwner(ownerId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        const hadStarting = ownerId in state.starting;
        if (current === undefined && !hadStarting) return state;
        const byOwner = { ...state.byOwner };
        delete byOwner[ownerId];
        const starting = { ...state.starting };
        delete starting[ownerId];
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        const parkState = { ...state.parkState };
        const harness = { ...state.harness };
        for (const tab of current?.tabs ?? []) {
          forgetTabIndexes(sessionOwner, lastOutputAt, parkState, harness, tab);
        }
        return { byOwner, starting, sessionOwner, lastOutputAt, parkState, harness };
      });
    },
  }));
}

export const useSessionsStore = createSessionsStore();

/**
 * Wires the single `api.sessions.onHarnessEvent` subscription into the store —
 * the renderer end of the involuntary channel (docs/plans/harness-events.md).
 * Mount once from an always-mounted site, the same reasoning as
 * `subscribeWorktreePhases`: `SessionsLayer` is the one component alive for the
 * whole app session, and every live terminal already routes through it. Returns
 * the unsubscribe function for the caller's effect cleanup, so a remount can
 * never leave a second listener double-applying events.
 *
 * A notice for a session with no expectation yet REGISTERS one before folding
 * the event in. {@link SessionsState.addSession} covers the launches Volli
 * itself issued as agents through an adapter it can describe; what it cannot
 * cover still reports just as truthfully and would otherwise be dropped by
 * `applyHarnessEvent`'s unregistered guard — an agent the user started by hand
 * inside a wrapped shell, and a harness trusted since this renderer last
 * asked. Seeding on delivery is the plan's own rule ("an event becomes
 * verified on first real delivery") rather than a shortcut around it: the tier
 * is `hooked` because an event demonstrably arrived, and the declared-event set
 * comes from the adapter — the catalog's as readily as a built-in's — so cursor,
 * whose source maps both blocking signals to null, still cannot raise a
 * `waiting` it isn't able to vouch for.
 *
 * The unknown id keeps FAILING OPEN, and that must not be tidied away now that
 * the catalog exists: an id nothing here can describe is credited with the whole
 * event vocabulary, because the alternative is silencing the one harness that
 * has just proved it reports. The delivery is all the evidence there is, and
 * disbelieving it would hide a harness that IS reporting.
 *
 * Notices arrive in the order main ingested them, which is NOT the order the
 * harness fired them — each event races here on its own hook process. The
 * `firedAt` each one carries is what settles that, applied by
 * `receiveHarnessEvent` rather than filtered here, so this end and main's end
 * enforce one shared rule instead of two hand-copied ones. `startedAt` stays on
 * `at`: the grace window measures how long Volli has been waiting to hear
 * anything, and that is main's clock's question, not the harness's.
 */
export function subscribeHarnessEvents(): () => void {
  return window.api.sessions.onHarnessEvent((notice) => {
    const state = useSessionsStore.getState();
    if (state.harness[notice.sessionId] === undefined) {
      const adapter = launchAdapter(notice.harnessId);
      state.expectHarnessEvents(notice.sessionId, {
        harnessId: notice.harnessId,
        expectedTier: "hooked",
        declaredEvents: adapter === undefined ? HARNESS_EVENTS : [...supportedEvents(adapter)],
        startedAt: notice.at,
      });
    }
    state.applyHarnessEvent(notice.sessionId, notice.event, notice.firedAt);
  });
}

/**
 * Wires the `api.sessions.onHarnessChange` subscription — the renderer end of
 * the wrapper announce. Mounted once beside {@link subscribeHarnessEvents}, and
 * kept a SEPARATE subscription rather than folded into it because the two
 * channels answer different questions: one is what the agent is doing, this is
 * which agent it is.
 *
 * Two things move, because a session's harness is remembered in two shapes. The
 * durable record carries `activeHarnessId`, which is what every label and
 * resume affordance reads through `effectiveHarnessId`; the live harness state
 * carries what is expected to report. Updating only one leaves the ticket rail
 * naming a harness the sidebar has already stopped believing in.
 *
 * They move on different conditions, which is what `notice.changed` is for.
 * Every announce is a launch, so the live state is always rebuilt; the durable
 * record only names WHICH harness, so it is repointed only when that moved. An
 * unconditional repoint would hand the rail a new record object per launch,
 * carrying the value it already had.
 */
export function subscribeSessionHarness(): () => void {
  return window.api.sessions.onHarnessChange((notice) => {
    useSessionsStore.getState().announceHarness(notice.sessionId, notice.harnessId, notice.at);
    if (notice.changed && notice.ticketId !== null) {
      useTicketSessionRecordsStore
        .getState()
        .setActiveHarness(notice.ticketId, notice.sessionId, notice.harnessId);
    }
  });
}
