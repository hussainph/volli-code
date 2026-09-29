/**
 * VC-354 — React/Zustand sidebar profile at the measured real-profile scale.
 *
 * This mounts the shipped `ActiveSessions` component in its own non-StrictMode
 * root, seeds the real stores with 1,198 Sessions / 392 tickets / 50 worktrees,
 * and drives the writes the audit needs to distinguish:
 *
 *   - a burst of six pushed chat activity rows for this project;
 *   - a resident chat-slice write (the title selector runs, but should bail);
 *   - open-chat-tab changes for this project and for another project;
 *   - terminal output for this project and for another project;
 *   - park and harness state for this project and for another project;
 *   - container metadata for this project and for another project.
 *
 * `<Profiler>` boundaries cover the component as a whole and its Active and
 * Previous bands. `PerformanceObserver("longtask")` records scheduler stalls in
 * the same artifact. The Playwright driver in `e2e/sidebar-store-bench.mjs`
 * runs this page under both background-load arms and writes the JSON report.
 *
 * The fixture construction is outside every measured interval. Absolute times
 * are dev-mode React and machine-local; before/after runs from one checkout on
 * one machine are the comparable result.
 */
import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  createSessionHarnessState,
  EMPTY_SESSION_USAGE_SUMMARY,
  getHarnessAdapter,
  PERSON_STARTED,
  type ChatSessionRecord,
  type ModelSelection,
  type Project,
  type SessionHarnessState,
  type SessionListingRow,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";

import { buildActiveSessionListing } from "@renderer/components/sidebar/active-session-listing";
import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { Sidebar, SidebarContent, SidebarProvider } from "@renderer/components/ui/sidebar";
import { appStateStorage } from "@renderer/lib/app-state-storage";
import { EMPTY_NAV_HISTORY } from "@renderer/lib/nav-history";
import { useBoardStore } from "@renderer/stores/board";
import { createChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  type ProjectSessionRows,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import {
  type SessionContainer,
  type SessionTab,
  useSessionsStore,
} from "@renderer/stores/sessions";
import { createUiStore } from "@renderer/stores/ui";
import {
  createWorkspaceStore,
  DEFAULT_WORKSPACE_UI,
  useWorkspaceStore,
  type TicketTabsState,
  type WorkspaceUiState,
} from "@renderer/stores/workspace";

import type { ApiOverrides } from "../fake-api";
import { appApi, seedApp } from "../seed";

export const title = "Sidebar sessions · store performance";
export const note = "Profiler + long-task matrix at 1,198 Sessions / 392 tickets / 50 worktrees";
export const viewport = "window" as const;

const TICKET_COUNT = 392;
const SESSION_COUNT = 1_198;
const TERMINAL_COUNT = 392;
const CHAT_COUNT = SESSION_COUNT - TERMINAL_COUNT;
const WORKTREE_COUNT = 50;
const LIVE_TERMINALS = 8;
const LIVE_CHATS = 8;
const STREAMS = 6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUILT_AT = Date.now();
const OTHER_PROJECT_ID = "perf-other-project";
const OTHER_SESSION_ID = "perf-other-session";

const PERF_PROJECT: Project = {
  id: "perf-project",
  name: "VC-354 real fixture",
  path: "/tmp/volli-vc354-real",
  ticketPrefix: "PERF",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: BUILT_AT - 90 * DAY,
  updatedAt: BUILT_AT,
};

function buildTicket(index: number): Ticket {
  const ticketNumber = index + 1;
  const hasWorktree = index < WORKTREE_COUNT;
  return {
    id: `perf-ticket-${ticketNumber}`,
    projectId: PERF_PROJECT.id,
    ticketNumber,
    title: `Scale fixture ticket ${ticketNumber}: preserve grouping, ordering, filters and selection`,
    body: "",
    status: index % 17 === 0 ? "needs_review" : index % 5 === 0 ? "doing" : "todo",
    priority: index % 11 === 0 ? "high" : index % 7 === 0 ? "low" : "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: index,
    worktreePath: hasWorktree ? `/tmp/volli-vc354-real/PERF-${ticketNumber}` : null,
    branch: hasWorktree ? `volli/PERF-${ticketNumber}-scale-fixture` : null,
    baseBranch: hasWorktree ? "main" : null,
    prUrl: null,
    createdAt: BUILT_AT - (90 - (index % 30)) * DAY,
    updatedAt: BUILT_AT - (index % 120) * MINUTE,
  };
}

const PERF_TICKETS: Ticket[] = Array.from({ length: TICKET_COUNT }, (_, index) =>
  buildTicket(index),
);

function terminalRecord(index: number): SessionRecord {
  const ticket = PERF_TICKETS[index % PERF_TICKETS.length]!;
  const live = index < LIVE_TERMINALS;
  const id = `perf-terminal-${index + 1}`;
  const createdAt = BUILT_AT - (index + 3) * HOUR;
  return {
    id,
    projectId: PERF_PROJECT.id,
    ticketId: ticket.id,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    title: `Terminal ${index + 1}`,
    cwd: ticket.worktreePath ?? PERF_PROJECT.path,
    createdAt,
    endedAt: live ? null : BUILT_AT - (31 * MINUTE + (index % 6) * HOUR),
    exitCode: live ? null : index % 19 === 0 ? 1 : 0,
    lastActivityAt: live ? BUILT_AT - (index + 1) * 1_000 : BUILT_AT - (index % 6) * HOUR,
    bornTicketless: false,
  };
}

/**
 * One policy object shared by every generated row. The sidebar draws no model,
 * so the rows differ in nothing this scratch measures — and a scale fixture
 * that minted a fresh object per row would be charging its own allocations to
 * the render it exists to time.
 */
const PERF_MODEL: ModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "medium",
};

function chatRecord(index: number): ChatSessionRecord {
  const ticket = PERF_TICKETS[(index * 17) % PERF_TICKETS.length]!;
  const live = index < LIVE_CHATS;
  const lastActivityAt = live
    ? BUILT_AT - (index + 1) * 1_000
    : BUILT_AT - (31 * MINUTE + (index % 150) * MINUTE);
  return {
    sessionId: `perf-chat-${index + 1}`,
    projectId: PERF_PROJECT.id,
    ticketId: ticket.id,
    title: index % 9 === 0 ? "Chat" : `Scale fixture chat ${index + 1}`,
    createdAt: lastActivityAt - 40 * MINUTE,
    adapterId: "pi",
    live,
    activity: live ? "working" : "idle",
    waitingOn: null,
    outcome: null,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: PERF_MODEL,
    lastActivityAt,
  };
}

const PERF_TERMINALS: readonly SessionRecord[] = Array.from(
  { length: TERMINAL_COUNT },
  (_, index) => terminalRecord(index),
);
const PERF_CHATS: readonly ChatSessionRecord[] = Array.from({ length: CHAT_COUNT }, (_, index) =>
  chatRecord(index),
);
const PERF_ROWS: ProjectSessionRows = {
  terminal: PERF_TERMINALS,
  chat: PERF_CHATS,
  provenance: {},
};
const SESSION_ROWS: readonly SessionListingRow[] = [
  ...PERF_TERMINALS.map((record): SessionListingRow => ({
    kind: "terminal",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  })),
  ...PERF_CHATS.map((record): SessionListingRow => ({
    kind: "chat",
    record,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  })),
];

function terminalTab(record: SessionRecord): SessionTab {
  return {
    sessionId: record.id,
    title: record.title,
    scope: { kind: "ticket", projectId: record.projectId, ticketId: record.ticketId! },
    layout: { kind: "pane", sessionId: record.id, exitCode: null },
    activePaneId: record.id,
  };
}

const PERF_CONTAINERS: Record<string, SessionContainer> = {};
const PERF_SESSION_OWNERS: Record<string, string> = {};
for (const record of PERF_TERMINALS.slice(0, LIVE_TERMINALS)) {
  const ownerId = record.ticketId!;
  PERF_CONTAINERS[ownerId] = { tabs: [terminalTab(record)], activeSessionId: record.id };
  PERF_SESSION_OWNERS[record.id] = ownerId;
}
PERF_CONTAINERS[OTHER_PROJECT_ID] = {
  tabs: [
    {
      sessionId: OTHER_SESSION_ID,
      title: "Other project terminal",
      scope: { kind: "project", projectId: OTHER_PROJECT_ID },
      layout: { kind: "pane", sessionId: OTHER_SESSION_ID, exitCode: null },
      activePaneId: OTHER_SESSION_ID,
    },
  ],
  activeSessionId: OTHER_SESSION_ID,
};
PERF_SESSION_OWNERS[OTHER_SESSION_ID] = OTHER_PROJECT_ID;

const CLAUDE_ADAPTER = getHarnessAdapter("claude-code");
if (CLAUDE_ADAPTER === undefined) throw new Error("VC-354 fixture: missing claude-code adapter");

function harnessState(sequence: number): SessionHarnessState {
  return createSessionHarnessState({
    harnessId: "claude-code",
    adapter: CLAUDE_ADAPTER,
    startedAt: BUILT_AT + sequence,
  });
}

export const api: ApiOverrides = {
  ...appApi,
  sessions: {
    list: async () => ({ ok: true, sessions: SESSION_ROWS }),
  },
  tickets: {
    latestSignals: async () => ({ ok: true, signals: [] }),
    statusEntries: async () => ({ ok: true, entries: [] }),
  },
};

export function seed(): void {
  seedApp();
  useBoardStore.setState((state) => ({
    ...state,
    ticketsByProject: { [PERF_PROJECT.id]: PERF_TICKETS },
  }));
  useWorkspaceStore.setState({
    byProject: {
      [PERF_PROJECT.id]: { ...DEFAULT_WORKSPACE_UI, nav: "home" },
    },
    navHistory: EMPTY_NAV_HISTORY,
  });
  useProjectSessionsStore.setState({
    byProject: { [PERF_PROJECT.id]: PERF_ROWS },
    listingState: { [PERF_PROJECT.id]: "loaded" },
  });
  useSessionsStore.setState({
    byOwner: PERF_CONTAINERS,
    sessionOwner: PERF_SESSION_OWNERS,
    lastOutputAt: {},
    parkState: {},
    harness: {},
    starting: {},
  });
  useChatSessionsStore.setState({
    sessions: Object.fromEntries(
      PERF_CHATS.slice(0, LIVE_CHATS).map((record) => [record.sessionId, seedSlice("working")]),
    ),
    openTabs: Object.fromEntries(
      PERF_CHATS.slice(0, LIVE_CHATS).map((record) => [record.ticketId!, [record.sessionId]]),
    ),
    rehomedTicketBySession: {},
    starting: {},
  });
}

interface ProfileSample {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
}

interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface ProfileSummary {
  commits: number;
  totalActualMs: number;
  medianActualMs: number;
  p95ActualMs: number;
  maxActualMs: number;
  medianBaseMs: number;
}

interface ScenarioResult {
  writes: number;
  samples: number;
  commitWallMs: { median: number; p95: number; max: number };
  paintWallMs: { median: number; p95: number; max: number };
  profilers: Record<string, ProfileSummary>;
  longTasks: LongTaskSummary;
}

interface SyncTimingSummary {
  median: number;
  p95: number;
  max: number;
}

interface PersistenceScenarioResult {
  samples: number;
  writes: number;
  payloadBytes: number;
  actionWallMs: { median: number; p95: number; max: number };
  partializeMs: { median: number; p95: number; max: number };
  jsonSerializeMs: { median: number; p95: number; max: number };
  appStateScheduleMs: { median: number; p95: number; max: number };
}

interface SidebarPerfResult {
  fixture: SidebarPerfApi["fixture"];
  domNodes: number;
  sessionRows: { active: number; previous: number };
  scenarios: Record<string, ScenarioResult>;
  persistence: Record<string, PersistenceScenarioResult>;
  derivation: Record<string, SyncTimingSummary>;
}

interface SidebarPerfApi {
  ready: boolean;
  fixture: {
    sessions: number;
    terminals: number;
    chats: number;
    tickets: number;
    worktrees: number;
    liveTerminals: number;
    liveChats: number;
  };
  run(samples?: number): Promise<SidebarPerfResult>;
}

declare global {
  interface Window {
    sidebarPerf?: SidebarPerfApi;
  }
}

let profileLog: ProfileSample[] = [];
let sequence = 0;

const onProfile: React.ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  profileLog.push({ id, phase, actualDuration, baseDuration });
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundFine(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
}

function raf(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
}

async function nextPaint(): Promise<number> {
  await raf();
  return raf();
}

function summarizeTimes(values: readonly number[]) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: round(Math.max(0, ...values)),
  };
}

function summarizeFineTimes(values: readonly number[]): SyncTimingSummary {
  const at = (fraction: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].toSorted((left, right) => left - right);
    return roundFine(
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0,
    );
  };
  return { median: at(0.5), p95: at(0.95), max: roundFine(Math.max(0, ...values)) };
}

function summarizeProfiles(samples: readonly ProfileSample[]): Record<string, ProfileSummary> {
  const grouped = new Map<string, ProfileSample[]>();
  for (const sample of samples) {
    const rows = grouped.get(sample.id) ?? [];
    rows.push(sample);
    grouped.set(sample.id, rows);
  }
  return Object.fromEntries(
    [...grouped].map(([id, rows]) => {
      const actual = rows.map((row) => row.actualDuration);
      return [
        id,
        {
          commits: rows.length,
          totalActualMs: round(actual.reduce((sum, value) => sum + value, 0)),
          medianActualMs: percentile(actual, 0.5),
          p95ActualMs: percentile(actual, 0.95),
          maxActualMs: round(Math.max(0, ...actual)),
          medianBaseMs: percentile(
            rows.map((row) => row.baseDuration),
            0.5,
          ),
        },
      ];
    }),
  );
}

function measureSync(samples: number, run: (sample: number) => void): number[] {
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    run(sample);
    values.push(performance.now() - started);
  }
  return values;
}

function storageProbe() {
  let writes = 0;
  let lastValue = "";
  return {
    storage: {
      getItem: (_key: string): string | null => null,
      setItem: (_key: string, value: string): void => {
        writes += 1;
        lastValue = value;
      },
      removeItem: (_key: string): void => {},
    },
    reset(): void {
      writes = 0;
      lastValue = "";
    },
    read(): { writes: number; lastValue: string } {
      return { writes, lastValue };
    },
  };
}

function persistenceWorkspaceUi(): WorkspaceUiState {
  const ticketTabs = Object.fromEntries(
    PERF_TICKETS.map((ticket, index) => {
      const relPath = `src/perf-${index + 1}.ts`;
      const tabs: TicketTabsState = {
        files: [{ relPath, pinned: true }],
        diffs: [relPath],
        diffMeta: {},
        tabOrder: [],
        active: "doc",
      };
      return [ticket.id, tabs];
    }),
  );
  const projectFiles = Array.from({ length: WORKTREE_COUNT }, (_, index) => ({
    relPath: `packages/perf-${index + 1}/index.ts`,
    pinned: true,
  }));
  return {
    ...DEFAULT_WORKSPACE_UI,
    boardView: "list",
    openTicketId: PERF_TICKETS[0]!.id,
    ticketTabs,
    projectFiles: { tabs: projectFiles, activeRelPath: projectFiles[0]!.relPath },
  };
}

function measurePersistenceScenario<State>(input: {
  name: string;
  samples: number;
  action(sample: number): void;
  readState(): State;
  partialize(state: State): unknown;
  version: number;
  probe: ReturnType<typeof storageProbe>;
}): PersistenceScenarioResult {
  // Warm the reducer, middleware and serializer before the timed samples. The
  // probe is reset afterward, so `writes` describes only the measured calls.
  for (let sample = -8; sample < 0; sample += 1) input.action(sample);
  input.probe.reset();
  const actionTimes = measureSync(input.samples, input.action);

  const state = input.readState();
  const partializeTimes = measureSync(input.samples, () => input.partialize(state));
  const persisted = input.partialize(state);
  const serializeTimes = measureSync(input.samples, () => {
    JSON.stringify({ state: persisted, version: input.version });
  });
  const payload = JSON.stringify({ state: persisted, version: input.version });

  // This is the shipped synchronous write-through face: cache update +
  // trailing-edge debounce scheduling. The IPC + SQLite UPSERT happen later
  // and therefore cannot extend the store action's task.
  const storageKey = `volli:vc354-perf:${input.name}`;
  const appStateScheduleTimes = measureSync(input.samples, () => {
    appStateStorage.setItem(storageKey, payload);
  });
  appStateStorage.removeItem(storageKey);

  const measured = input.probe.read();
  return {
    samples: input.samples,
    writes: measured.writes,
    payloadBytes: new TextEncoder().encode(measured.lastValue || payload).byteLength,
    actionWallMs: summarizeFineTimes(actionTimes),
    partializeMs: summarizeFineTimes(partializeTimes),
    jsonSerializeMs: summarizeFineTimes(serializeTimes),
    appStateScheduleMs: summarizeFineTimes(appStateScheduleTimes),
  };
}

function measurePersistence(samples: number): Record<string, PersistenceScenarioResult> {
  const persistenceSamples = Math.max(200, samples * 20);

  const uiProbe = storageProbe();
  const ui = createUiStore(uiProbe.storage);
  const uiOptions = ui.persist.getOptions();
  const uiPartialize = uiOptions.partialize ?? ((state) => state);

  const workspaceProbe = storageProbe();
  const workspace = createWorkspaceStore(workspaceProbe.storage);
  workspace.setState({
    byProject: { [PERF_PROJECT.id]: persistenceWorkspaceUi() },
    navHistory: EMPTY_NAV_HISTORY,
  });
  const workspaceOptions = workspace.persist.getOptions();
  const workspacePartialize = workspaceOptions.partialize ?? ((state) => state);

  const draftsProbe = storageProbe();
  const drafts = createChatDraftsStore(draftsProbe.storage);
  const draftBody = "x".repeat(1_024);
  for (let index = 0; index < 50; index += 1) {
    drafts.getState().setDraft(`perf-draft-${index + 1}`, `${draftBody}${index}`);
  }
  const draftsOptions = drafts.persist.getOptions();
  const draftsPartialize = draftsOptions.partialize ?? ((state) => state);

  return {
    uiTransient: measurePersistenceScenario({
      name: "ui-transient",
      samples: persistenceSamples,
      action: (sample) => ui.getState().setSettingsOpen(sample % 2 === 0),
      readState: ui.getState,
      partialize: uiPartialize,
      version: uiOptions.version ?? 0,
      probe: uiProbe,
    }),
    workspaceTransient: measurePersistenceScenario({
      name: "workspace-transient",
      samples: persistenceSamples,
      action: (sample) =>
        workspace.getState().recordNav({
          projectId: PERF_PROJECT.id,
          nav: "home",
          openTicketId: PERF_TICKETS[Math.abs(sample) % 2]!.id,
        }),
      readState: workspace.getState,
      partialize: workspacePartialize,
      version: workspaceOptions.version ?? 0,
      probe: workspaceProbe,
    }),
    chatDraftKeystroke: measurePersistenceScenario({
      name: "chat-draft-keystroke",
      samples: persistenceSamples,
      action: (sample) =>
        drafts
          .getState()
          .setDraft("perf-draft-1", `${draftBody}${Math.abs(sample) % 10}${sample % 2}`),
      readState: drafts.getState,
      partialize: draftsPartialize,
      version: draftsOptions.version ?? 0,
      probe: draftsProbe,
    }),
  };
}

function measureDerivation(samples: number): Record<string, SyncTimingSummary> {
  const derivationSamples = Math.max(200, samples * 20);
  const listingInput = {
    tickets: PERF_TICKETS,
    containers: PERF_CONTAINERS,
    projectContainer: PERF_CONTAINERS[PERF_PROJECT.id],
    signalsByTicket: {},
    records: PERF_TERMINALS,
    chatSessions: PERF_CHATS,
    lastOutputAt: {},
    parkState: {},
    harness: {},
    now: BUILT_AT,
  };
  return {
    fullListingBuild: summarizeFineTimes(
      measureSync(derivationSamples, () => {
        buildActiveSessionListing(listingInput);
      }),
    ),
    terminalRecordIndex: summarizeFineTimes(
      measureSync(
        derivationSamples,
        () => new Map(PERF_TERMINALS.map((record) => [record.id, record])),
      ),
    ),
    ticketIndex: summarizeFineTimes(
      measureSync(
        derivationSamples,
        () => new Map(PERF_TICKETS.map((ticket) => [ticket.id, ticket])),
      ),
    ),
  };
}

async function measureScenario(
  samples: number,
  writesPerSample: number,
  mutate: () => void,
): Promise<ScenarioResult> {
  profileLog = [];
  const commitWall: number[] = [];
  const paintWall: number[] = [];
  const tasks: PerformanceEntry[] = [];
  const observer =
    typeof PerformanceObserver === "undefined"
      ? null
      : new PerformanceObserver((list) => tasks.push(...list.getEntries()));
  observer?.observe({ type: "longtask", buffered: false });

  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    flushSync(mutate);
    const committed = performance.now();
    const painted = await nextPaint();
    commitWall.push(committed - started);
    paintWall.push(painted - started);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  tasks.push(...(observer?.takeRecords() ?? []));
  observer?.disconnect();

  return {
    writes: samples * writesPerSample,
    samples,
    commitWallMs: summarizeTimes(commitWall),
    paintWallMs: summarizeTimes(paintWall),
    profilers: summarizeProfiles(profileLog),
    longTasks: {
      count: tasks.length,
      totalMs: round(tasks.reduce((sum, task) => sum + task.duration, 0)),
      maxMs: round(Math.max(0, ...tasks.map((task) => task.duration))),
    },
  };
}

function pushProjectChatActivity(): void {
  for (let stream = 0; stream < STREAMS; stream += 1) {
    const sessionId = `perf-chat-${stream + 1}`;
    const current = useProjectSessionsStore
      .getState()
      .byProject[PERF_PROJECT.id]!.chat.find((record) => record.sessionId === sessionId)!;
    sequence += 1;
    useProjectSessionsStore.getState().applyActivity({
      projectId: PERF_PROJECT.id,
      ticketId: current.ticketId,
      row: {
        kind: "chat",
        record: {
          ...current,
          live: true,
          activity: "working",
          lastActivityAt: BUILT_AT + sequence,
        },
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    });
  }
}

function writeResidentChatSlice(): void {
  const sessionId = `perf-chat-${(sequence % LIVE_CHATS) + 1}`;
  sequence += 1;
  useChatSessionsStore.setState((state) => {
    const current = state.sessions[sessionId]!;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          lifecycle: current.lifecycle === "working" ? "ready" : "working",
        },
      },
    };
  });
}

function writeOpenChatTabs(ownerId: string): void {
  sequence += 1;
  useChatSessionsStore.setState((state) => ({
    openTabs: {
      ...state.openTabs,
      [ownerId]: [`perf-open-tab-${sequence}`],
    },
  }));
}

function bumpTerminalOutput(sessionId: string): void {
  sequence += 1;
  useSessionsStore.getState().bumpOutput(sessionId, BUILT_AT + sequence * 2_000);
}

function writeParkState(sessionId: string): void {
  sequence += 1;
  useSessionsStore.getState().setParkState(sessionId, sequence % 2 === 0, false);
}

function writeHarness(sessionId: string): void {
  sequence += 1;
  useSessionsStore.setState((state) => ({
    harness: { ...state.harness, [sessionId]: harnessState(sequence) },
  }));
}

function writeContainer(ownerId: string): void {
  sequence += 1;
  useSessionsStore.setState((state) => {
    const current = state.byOwner[ownerId]!;
    const first = current.tabs[0]!;
    return {
      byOwner: {
        ...state.byOwner,
        [ownerId]: {
          ...current,
          tabs: [{ ...first, title: `Container revision ${sequence}` }, ...current.tabs.slice(1)],
        },
      },
    };
  });
}

function countRows(band: "active" | "previous"): number {
  const header = document.querySelector(`[data-session-band="${band}"] > div`)?.textContent ?? "";
  const match = /\d+/.exec(header);
  return match === null ? 0 : Number.parseInt(match[0], 10);
}

async function runMatrix(samples: number) {
  const scenarios: Record<string, ScenarioResult> = {};
  scenarios.projectChatBurst = await measureScenario(samples, STREAMS, pushProjectChatActivity);
  scenarios.residentChatSlice = await measureScenario(samples, 1, writeResidentChatSlice);
  scenarios.ownOpenChatTabs = await measureScenario(samples, 1, () =>
    writeOpenChatTabs("perf-ticket-1"),
  );
  scenarios.otherProjectOpenChatTabs = await measureScenario(samples, 1, () =>
    writeOpenChatTabs(OTHER_PROJECT_ID),
  );
  scenarios.ownTerminalOutput = await measureScenario(samples, 1, () =>
    bumpTerminalOutput("perf-terminal-1"),
  );
  scenarios.otherProjectTerminalOutput = await measureScenario(samples, 1, () =>
    bumpTerminalOutput(OTHER_SESSION_ID),
  );
  scenarios.ownParkState = await measureScenario(samples, 1, () =>
    writeParkState("perf-terminal-1"),
  );
  scenarios.otherProjectParkState = await measureScenario(samples, 1, () =>
    writeParkState(OTHER_SESSION_ID),
  );
  scenarios.ownHarness = await measureScenario(samples, 1, () => writeHarness("perf-terminal-1"));
  scenarios.otherProjectHarness = await measureScenario(samples, 1, () =>
    writeHarness(OTHER_SESSION_ID),
  );
  scenarios.ownContainer = await measureScenario(samples, 1, () => writeContainer("perf-ticket-1"));
  scenarios.otherProjectContainer = await measureScenario(samples, 1, () =>
    writeContainer(OTHER_PROJECT_ID),
  );
  return {
    fixture: window.sidebarPerf!.fixture,
    domNodes: document.querySelector("[data-perf-sidebar]")?.querySelectorAll("*").length ?? 0,
    sessionRows: { active: countRows("active"), previous: countRows("previous") },
    scenarios,
    persistence: measurePersistence(samples),
    derivation: measureDerivation(samples),
  };
}

function PerfHarness() {
  React.useEffect(() => {
    const perf: SidebarPerfApi = {
      ready: false,
      fixture: {
        sessions: SESSION_COUNT,
        terminals: TERMINAL_COUNT,
        chats: CHAT_COUNT,
        tickets: TICKET_COUNT,
        worktrees: WORKTREE_COUNT,
        liveTerminals: LIVE_TERMINALS,
        liveChats: LIVE_CHATS,
      },
      run: runMatrix,
    };
    window.sidebarPerf = perf;
    let cancelled = false;
    void (async () => {
      // Let ActiveSessions' baseline fetch and mount effects settle before the
      // benchmark resets the Profiler log. Otherwise mount hydration becomes
      // the first "stream" sample and makes the two arms incomparable.
      await nextPaint();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await nextPaint();
      if (cancelled) return;
      profileLog = [];
      perf.ready = true;
    })();
    return () => {
      cancelled = true;
      delete window.sidebarPerf;
    };
  }, []);

  return (
    <div data-perf-sidebar className="h-svh w-[340px] bg-sidebar text-sidebar-foreground">
      <React.Profiler id="ActiveSessions" onRender={onProfile}>
        <SidebarProvider className="min-h-0 w-[340px]" defaultOpen>
          <Sidebar collapsible="none" className="relative h-svh w-[340px]">
            <SidebarContent>
              <ActiveSessions project={PERF_PROJECT} visible onProfile={onProfile} />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      </React.Profiler>
    </div>
  );
}

/** Own root: the lab shell is StrictMode, the product is not. */
export default function SidebarPerformanceScratch() {
  const host = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const node = host.current;
    if (node === null || node.dataset.perfMounted === "1") return;
    node.dataset.perfMounted = "1";
    createRoot(node).render(<PerfHarness />);
  }, []);

  return <div ref={host} className="h-svh w-full bg-background" />;
}
