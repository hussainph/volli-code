import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  shortSessionId,
  DEFAULT_AUTHORITY_POLICY,
  type BrowserTabBounds,
  type BrowserTabState,
  type SessionToolId,
} from "@volli/shared";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  readSessionAnswer,
  sessionRootThreadId,
} from "@volli/session-engine";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../agent-runtime/test-fixtures/scripted-provider";
import { browserAgentPort } from "../browser/agent-port";
import type { BrowserTabCreateOptions } from "../browser/backend";
import type { CdpTransport } from "../browser/cdp-controller";
import { BrowserPictureStore } from "../browser/picture-store";
import {
  BrowserTabRegistry,
  type BrowserTabChrome,
  type BrowserTabRecord,
} from "../browser/tab-registry";
import { insertProject, listProjects } from "../db/projects-repo";
import { createAgentToolDoor } from "../agent-tool-door";
import { createDetachedWorkTracker } from "../detached-work";
import { createWatches, type Watches } from "../watches";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createTicketSessionDelegationStore } from "./delegation-store";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createAgentShellPort } from "../shell/agent-port";
import { BackgroundShellHost, type BackgroundShellNotice } from "../shell/background-shell-host";
import { installHostLog } from "../log/root";
import { createDelegations, DELEGATION_ID_SUFFIXES } from "./delegate-session";
import type { DelegateSessionPorts } from "./delegate-session";
import { createPiNativeAdapter } from "./pi-adapter";
import type { SessionStartInput } from "./sessions";
import { supervisionMarker } from "./supervise-session";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";
import { testHostHandlers } from "../testing/host-handlers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Only the page engine is scripted: ownership, holds, cleanup queues and CDP
// snapshot formatting are the actual shared browser implementation.
class MemoryBrowser extends BrowserTabRegistry<BrowserTabRecord> {
  readonly closed: string[] = [];
  closeFailure: Error | null = null;
  loadGate: ReturnType<typeof deferred> | null = null;
  #next = 0;

  constructor() {
    super({
      createId: () => `tab-${++this.#next}`,
      publishState: () => undefined,
      publishClosed: () => undefined,
      pictures: new BrowserPictureStore({ createId: () => "picture", now: () => 0 }),
    });
  }

  open(input: BrowserTabCreateOptions): BrowserTabState {
    this.assertCapacity(input);
    const entry: BrowserTabRecord = {
      state: this.newTabState(this.deps.createId(), input),
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
      hold: null,
    };
    this.tabs.set(entry.state.tabId, entry);
    this.publish(entry, { loading: false });
    return { ...entry.state };
  }

  close(tabId: string): void {
    if (this.closeFailure !== null) throw this.closeFailure;
    this.closed.push(tabId);
    this.forgetEntry(tabId, this.requireTab(tabId));
  }

  navigate(tabId: string, url: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry, url);
    this.publish(entry, { loading: false });
    return { ...entry.state };
  }

  back(tabId: string): BrowserTabState {
    return { ...this.requireTab(tabId).state };
  }
  forward(tabId: string): BrowserTabState {
    return this.back(tabId);
  }
  reload(tabId: string): BrowserTabState {
    return this.back(tabId);
  }
  closeAll(): void {
    for (const id of this.tabs.keys()) this.close(id);
  }
  setBounds(tabId: string, _bounds: BrowserTabBounds): void {
    this.requireTab(tabId);
  }
  async capturePicture(): Promise<null> {
    return null;
  }
  transportFor(tabId: string): CdpTransport {
    this.requireTab(tabId);
    return {
      send: async (method) =>
        method === "Accessibility.getFullAXTree"
          ? {
              nodes: [
                {
                  nodeId: "1",
                  ignored: false,
                  role: { value: "RootWebArea" },
                  name: { value: "Fixture page" },
                  childIds: [],
                },
              ],
            }
          : {},
    };
  }
  async waitForLoad(tabId: string, signal: AbortSignal): Promise<void> {
    this.requireTab(tabId);
    await this.loadGate?.promise;
    signal.throwIfAborted();
  }
  protected liveChrome(entry: BrowserTabRecord): BrowserTabChrome {
    return {
      url: entry.state.url,
      title: "Fixture page",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  }
  protected applyWakePolicy(): void {}
  protected goOffScreen(): void {}
}

let db: TestDb | undefined;
let runtime: ReturnType<typeof createSessionRuntime> | undefined;
let unblockLoad: (() => void) | undefined;
let shellHost: BackgroundShellHost | undefined;
let watchHost: Watches | undefined;
afterEach(async () => {
  watchHost?.dispose();
  watchHost = undefined;
  unblockLoad?.();
  unblockLoad = undefined;
  await runtime?.close();
  runtime = undefined;
  await shellHost?.close();
  shellHost = undefined;
  db?.cleanup();
  db = undefined;
});

const MODEL = {
  providerId: "scripted-fixture",
  modelId: "scripted",
  reasoningLevel: "off" as const,
};
const SURFACE: readonly SessionToolId[] = [
  "browser_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_screenshot",
  "browser_console",
  "browser_acquire",
  "browser_release",
  "browser_find",
];
const openPage = (path: string): ScriptedReply => ({
  tool: { name: "browser_navigate", args: { url: `https://example.com/${path}` } },
});

const SHELL_SURFACE: readonly SessionToolId[] = ["shell_start", "shell_output", "shell_kill"];

/** `shells`: wire a real background shell host, and offer its tools (VC-809). */
function fixture(role: "project" | "ticket", options: { shells?: BackgroundShellHost } = {}) {
  const { shells } = options;
  // In the canonical order: the shell tools sit before `browser_find`.
  const surfaceTools: readonly SessionToolId[] =
    shells === undefined ? SURFACE : [...SURFACE.slice(0, -1), ...SHELL_SURFACE, "browser_find"];
  const database = (db = openTestDb());
  const directory = join(dirname(database.dbPath), "workspace");
  mkdirSync(directory);
  insertProject(database.db, testProject({ id: "project-1", path: directory }));
  const ticketId = role === "ticket" ? "ticket-1" : null;
  if (ticketId !== null) insertTicket(database.db, testTicket("project-1", { id: ticketId }));
  let clock = 1_000;
  // A Session's short handle is the first eight characters of its id, so a
  // Session id opens with its own number: the shared `session-` prefix would
  // give every Session here the same handle, and no verb could address one.
  const next = (kind: string) =>
    kind === "session" ? `s${clock++}-session` : `${kind}-${clock++}`;
  const wake = createSessionWakeBus(
    createSessionEngine({
      ledger: createSqliteSessionLedger(database.db),
      clock: { now: () => clock++ },
      ids: { next },
    }),
    { db: database.db },
  );
  const engine = wake.engine;
  const replies: ScriptedReply[] = [openPage("parent"), { text: "Parent ready" }];
  const script = scriptedProvider(replies);
  const browser = new MemoryBrowser();
  const artifacts = createFileTranscriptArtifactStore(
    join(dirname(database.dbPath), "transcripts"),
  );
  const resolveBrowserPort = vi.fn<
    NonNullable<Parameters<typeof createPiNativeAdapter>[0]["resolveBrowserPort"]>
  >((scope) => browserAgentPort({ backend: browser, scope, session: scope, cursorFor: undefined }));
  const adapter = createPiNativeAdapter({
    sessionDataDir: join(dirname(database.dbPath), "pi"),
    models: script.models,
    usageLimits: {
      fetch: async () => {
        throw new Error("fixture has no network");
      },
    },
    now: () => clock++,
    resolveBrowserPort,
    ...(shells === undefined
      ? {}
      : {
          resolveShellPort: (
            scope: Parameters<
              NonNullable<Parameters<typeof createPiNativeAdapter>[0]["resolveShellPort"]>
            >[0],
          ) =>
            createAgentShellPort({
              host: shells,
              scope,
              session: scope,
              workspacePath: directory,
              identity: { sessionId: scope.sessionId, ticketDisplayId: null },
              pathPrefixes: [],
            }),
        }),
    resolveRuntimeContext: async (sessionId) => {
      const { projection } = await host.projection({ sessionId });
      const session = projection.session;
      const surface = (await engine.listEvents({ sessionId })).find(
        ({ payload }) =>
          payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
      )?.payload;
      if (surface?.kind !== "session.input.recorded" || surface.input.kind !== "tool-surface") {
        throw new Error("Missing durable tool surface");
      }
      const common = {
        projectId: session.projectId,
        rootThreadId: sessionRootThreadId(sessionId),
        brief: "Browser lifecycle integration",
        model: MODEL,
        toolSurface: surface.input.tools,
        promptResources: [],
      };
      if (session.role === "subagent") {
        return {
          ...common,
          role: "subagent",
          ticketId: session.ticketId,
          parentSessionId: session.parentSessionId!,
        };
      }
      if (session.role === "ticket")
        return { ...common, role: "ticket", ticketId: session.ticketId! };
      return { ...common, role: "project", ticketId: null };
    },
  });
  const venue = { id: "local", kind: "local" as const };
  const host = (runtime = createSessionRuntime({
    engine,
    executors: createSessionExecutorSlot(adapter),
    artifacts,
    locations: {
      resolve: async () => ({ directory, venue }),
      prepare: async () => ({ directory, venue }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => clock++ },
    ids: { next },
  }));

  // The facade stub only supplies mint+attach; all durable lifecycle and turns
  // still traverse the real Runtime, Pi adapter, stream codec and artifacts.
  async function start(input: SessionStartInput) {
    const created = await host.command({
      commandId: `${input.operationId}:create`,
      command: {
        kind: "session.create",
        projectId: input.projectId,
        ticketId: input.ticketId,
        role: input.role,
        parentSessionId: input.parentSessionId ?? null,
        title: input.title,
      },
    });
    const sessionId = created.sessionId;
    await engine.getOrRecordSessionInput({
      sessionId,
      input: { kind: "tool-surface", tools: surfaceTools },
      provenance: { source: { kind: "system", id: "pi-runtime", detail: null }, venue: null },
    });
    const attached = await host.command({
      commandId: `${input.operationId}:attach`,
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    expect(attached.receipt?.status, JSON.stringify(attached)).toBe("accepted");
    const { throughSequence } = await host.projection({ sessionId });
    return {
      sessionId,
      state: "ready" as const,
      receipt: attached.receipt,
      throughSequence,
      model: MODEL,
    };
  }
  const submitSessionMessage = vi.fn<DelegateSessionPorts["submitSessionMessage"]>(
    async (input) => {
      const result = await host.command({
        commandId: input.commandId,
        sessionId: input.sessionId,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        command: {
          kind: "message.submit",
          message: {
            id: input.messageId,
            role: "user",
            parts: [{ type: "text", text: input.text }],
          },
        },
      });
      expect(result.receipt?.status, JSON.stringify(result)).toBe("accepted");
    },
  );
  const reports: string[] = [];
  const delegations = createDelegations({
    sessions: { start },
    submitSessionMessage,
    runtime: host,
    sessionEngine: engine,
    now: () => clock++,
    readTranscriptArtifact: (ref) => artifacts.read(ref),
    report: (message) => reports.push(message),
  });
  // Real watch delivery, with only its coalescing clock driven explicitly.
  const detached = createDetachedWorkTracker({
    reportFailure: (error) => reports.push(String(error)),
  });
  const timers = new Map<object, () => void>();
  const watches = (watchHost = createWatches({
    runtime: {
      projection: (input) => host.projection(input),
      subscribe: (query, listener, onError) => host.subscribe(query, listener, onError),
      command: (input) => {
        const delivery = host.command(input);
        detached.track(delivery);
        return delivery;
      },
    },
    sessionEngine: engine,
    subscribeSessionWake: wake.subscribe,
    subscribeTicketWake: () => () => {},
    readTranscriptArtifact: (ref) => artifacts.read(ref),
    readComment: () => null,
    pendingSubagents: (id) => delegations.liveChildren(id),
    detachedWork: detached,
    report: (message) => reports.push(message),
    setTimeout: (callback) => {
      const handle = {};
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as object);
    },
  }));
  const door = createAgentToolDoor({
    db: database.db,
    projects: () => listProjects(database.db),
    handlers: testHostHandlers({ db: database.db }),
    delegation: createTicketSessionDelegationStore(database.db),
    automations: () => null,
    now: () => clock++,
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    watches: () => watches,
    delegate: () => delegations,
    mcp: () => null,
    supervise: () => ({ sessionEngine: engine, runtime: host }),
  });
  async function flushWatchNotices() {
    for (const [handle, callback] of timers) {
      timers.delete(handle);
      callback();
    }
    await detached.drain();
  }
  return {
    host,
    engine,
    start,
    door,
    watches,
    flushWatchNotices,
    submitSessionMessage,
    delegations,
    browser,
    replies,
    script,
    ticketId,
    reports,
    resolveBrowserPort,
    artifacts,
  };
}

// No Electron or network: only the model replies and page wire are scripted.
describe("completed delegate browser cleanup (VC-754)", () => {
  it("records completion and the answer even when native tab cleanup throws", async () => {
    const f = fixture("project");
    const parent = await f.start({
      operationId: "parent",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Parent",
    });
    const child = await f.start({
      operationId: "child",
      projectId: "project-1",
      ticketId: null,
      role: "subagent",
      parentSessionId: parent.sessionId,
      title: "Helper",
    });
    f.replies.splice(0, f.replies.length, openPage("child"), { text: "Answer survives cleanup" });
    const lines: string[] = [];
    const undoLog = installHostLog({
      level: "warn",
      sink: { write: (_record, line) => lines.push(line) },
    });
    f.browser.closeFailure = new Error("native close failed");
    try {
      await f.submitSessionMessage({
        sessionId: child.sessionId,
        commandId: "child:first",
        messageId: "child:first-message",
        text: "Open a page",
      });
      const { projection } = await f.host.projection({ sessionId: child.sessionId });
      expect(projection.lastTurnOutcome).toBe("completed");
      expect(projection.liveExecutor?.status).toBe("open");
      expect(f.browser.list({ projectId: "project-1" })).toMatchObject([
        { ownerSessionId: child.sessionId, heldBy: null },
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("headless Browser tab cleanup failed");
      const answer = await readSessionAnswer(
        {
          listEvents: (query) => f.engine.listEvents(query),
          readArtifact: (ref) => f.artifacts.read(ref),
        },
        { sessionId: child.sessionId },
      );
      expect(answer.text).toBe("Answer survives cleanup");
      expect(
        (await f.engine.listEvents({ sessionId: child.sessionId })).filter(
          ({ payload }) => payload.kind === "turn.completed",
        ),
      ).toHaveLength(1);
    } finally {
      f.browser.closeFailure = null;
      undoLog();
    }
  });

  it.each(["project", "ticket"] as const)(
    "closes delegate pages with its attachment open, but retains %s pages",
    async (role) => {
      const f = fixture(role);
      const parent = await f.start({
        operationId: "parent",
        projectId: "project-1",
        ticketId: f.ticketId,
        role,
        title: "Parent",
      });
      await f.submitSessionMessage({
        sessionId: parent.sessionId,
        commandId: "parent:first",
        messageId: "parent:first-message",
        text: "Open a page",
      });
      const parentAttachment = (await f.host.projection({ sessionId: parent.sessionId })).projection
        .liveExecutor!;
      const parentTab = f.browser.list({ projectId: "project-1" })[0]!;
      expect(parentTab).toMatchObject({
        ownerSessionId: parent.sessionId,
        presentation: "headless",
        heldBy: null,
      });
      expect(f.browser.closed).toEqual([]);

      f.replies.push(
        openPage("child"),
        { text: "Child final answer" },
        { text: "Parent read the answer" },
      );
      const gate = (f.browser.loadGate = deferred());
      unblockLoad = gate.resolve;
      const delegation = await f.delegations.delegate({
        operationId: "delegate-1",
        parent: {
          ...(role === "ticket"
            ? { role: "ticket" as const, ticketId: f.ticketId! }
            : { role: "project" as const, ticketId: null }),
          projectId: "project-1",
          sessionId: parent.sessionId,
          rootThreadId: sessionRootThreadId(parent.sessionId),
          attachmentId: parentAttachment.id,
        },
        task: "Research the fixture page",
        title: "Browser helper",
        actor: { kind: "session", sessionId: parent.sessionId, ticketId: f.ticketId },
      });
      const childId = delegation.childSessionId;
      await vi.waitFor(() => expect(f.browser.list({ projectId: "project-1" })).toHaveLength(2));
      const childTab = f.browser
        .list({ projectId: "project-1" })
        .find((tab) => tab.ownerSessionId === childId)!;
      const active = (await f.host.projection({ sessionId: childId })).projection;
      expect(active.turnActive).toBe(true);
      expect(f.delegations.watching(childId)).toBe(true);
      expect(childTab).toMatchObject({
        presentation: "headless",
        heldBy: { kind: "session", sessionId: childId },
      });
      const attachment = active.liveExecutor!;
      f.browser.loadGate = null;
      gate.resolve();
      unblockLoad = undefined;

      await vi.waitFor(async () => {
        expect(f.browser.closed).toEqual([childTab.tabId]);
        expect(f.script.requests).toHaveLength(5);
        expect(
          (await f.host.projection({ sessionId: parent.sessionId })).projection.turnActive,
        ).toBe(false);
      });
      const completed = (await f.host.projection({ sessionId: childId })).projection;
      expect(completed).toMatchObject({
        turnActive: false,
        lastTurnOutcome: "completed",
        liveExecutor: { id: attachment.id, status: "open", native: attachment.native },
      });
      expect(f.delegations.watching(childId)).toBe(false);
      expect(f.browser.list({ projectId: "project-1" })).toEqual([parentTab]);
      const answer = await readSessionAnswer(
        {
          listEvents: (query) => f.engine.listEvents(query),
          readArtifact: (ref) => f.artifacts.read(ref),
        },
        { sessionId: childId },
      );
      expect(answer.text).toBe("Child final answer");
      const noticeId = `delegate-1${DELEGATION_ID_SUFFIXES.notice}`;
      const noticeEvents = () =>
        f.engine
          .listEvents({ sessionId: parent.sessionId })
          .then((events) =>
            events.filter(
              ({ payload }) =>
                payload.kind === "command.receipt.recorded" &&
                payload.receipt.commandId === noticeId,
            ),
          );
      expect(await noticeEvents()).toMatchObject([
        { payload: { receipt: { status: "accepted", commandId: noticeId } } },
      ]);
      expect(JSON.stringify(f.script.requests[4])).toContain("| Child final answer");
      expect(f.submitSessionMessage).toHaveBeenCalledTimes(2);

      // A second real turn uses the same open Pi attachment and opens a fresh
      // page; completion cleans that page too, without re-delivering the old notice.
      f.replies.push(openPage("resumed"), { text: "Resumed child answer" });
      await f.submitSessionMessage({
        sessionId: childId,
        commandId: "child:resume",
        messageId: "child:resume-message",
        text: "Research another page",
      });
      await vi.waitFor(() => expect(f.browser.closed).toHaveLength(2));
      const resumed = (await f.host.projection({ sessionId: childId })).projection;
      expect(resumed.liveExecutor?.id).toBe(attachment.id);
      expect(resumed.attachments).toHaveLength(1);
      expect(resumed.lastTurnOutcome).toBe("completed");
      const resumedAnswer = await readSessionAnswer(
        {
          listEvents: (query) => f.engine.listEvents(query),
          readArtifact: (ref) => f.artifacts.read(ref),
        },
        { sessionId: childId },
      );
      expect(resumedAnswer.text).toBe("Resumed child answer");
      expect(f.resolveBrowserPort).toHaveBeenCalledTimes(2);
      expect(f.browser.list({ projectId: "project-1" })).toEqual([parentTab]);
      expect(await noticeEvents()).toHaveLength(1);
      expect(f.script.requests).toHaveLength(7);
      expect(JSON.stringify(f.script.requests[5])).toContain("Child final answer");
      expect(f.reports).toEqual([]);
      const toolResults = f.script.requests.flatMap((request) =>
        request.filter((message) => message.role === "toolResult"),
      );
      expect(toolResults.every((message) => !message.isError)).toBe(true);
      expect(JSON.stringify(toolResults)).toContain("Fixture page");
      const events = await f.engine.listEvents({ sessionId: childId });
      expect(events.filter(({ payload }) => payload.kind === "turn.completed")).toHaveLength(2);
      expect(events.filter(({ payload }) => payload.kind === "attachment.closed")).toEqual([]);
    },
  );
});

/**
 * A parent steering the child it delegated (VC-861). The steer is the ordinary
 * supervision verb — the marked message the `session_send` door submits — so
 * the child reads owner direction at its next step of the turn already running,
 * that one turn still ends, and the delegation answers under its one
 * `<operation>:answer` id rather than a second, resume-keyed notice.
 */
describe("a parent steers the delegate it started (VC-861)", () => {
  it.each(["project", "ticket"] as const)(
    "joins a %s Session's running child turn and reports exactly once",
    async (role) => {
      const f = fixture(role);
      const parent = await f.start({
        operationId: "parent",
        projectId: "project-1",
        ticketId: f.ticketId,
        role,
        title: "Parent",
      });
      await f.submitSessionMessage({
        sessionId: parent.sessionId,
        commandId: "parent:first",
        messageId: "parent:first-message",
        text: "Open a page",
      });
      const parentAttachment = (await f.host.projection({ sessionId: parent.sessionId })).projection
        .liveExecutor!;
      const parentTurnActive = async () =>
        (await f.host.projection({ sessionId: parent.sessionId })).projection.turnActive;
      /**
       * The parent's durable "your delegate answered" receipts. Exactly one is
       * the contract: a `:resume:` notice for the same turn would land here too.
       */
      const noticeReceipts = async () =>
        (await f.engine.listEvents({ sessionId: parent.sessionId })).filter(
          ({ payload }) =>
            payload.kind === "command.receipt.recorded" &&
            payload.receipt.commandId.startsWith("delegate-1") &&
            payload.receipt.commandId.endsWith(DELEGATION_ID_SUFFIXES.notice),
        );

      // The child's first step holds a real page load open, so the delegation
      // is genuinely mid-turn when the parent steers — not idle between turns.
      f.replies.push(
        openPage("child"),
        { text: "Child final answer" },
        { text: "Parent read the answer" },
      );
      const gate = (f.browser.loadGate = deferred());
      unblockLoad = gate.resolve;
      const delegation = await f.delegations.delegate({
        operationId: "delegate-1",
        parent: {
          ...(role === "ticket"
            ? { role: "ticket" as const, ticketId: f.ticketId! }
            : { role: "project" as const, ticketId: null }),
          projectId: "project-1",
          sessionId: parent.sessionId,
          rootThreadId: sessionRootThreadId(parent.sessionId),
          attachmentId: parentAttachment.id,
        },
        task: "Research the fixture page",
        title: "Browser helper",
        actor: { kind: "session", sessionId: parent.sessionId, ticketId: f.ticketId },
      });
      const childId = delegation.childSessionId;
      expect(delegation.state).toBe("running");
      await vi.waitFor(() => expect(f.browser.list({ projectId: "project-1" })).toHaveLength(2));
      expect((await f.host.projection({ sessionId: childId })).projection).toMatchObject({
        turnActive: true,
        liveExecutor: { status: "open" },
      });
      expect(f.delegations.liveChildren(parent.sessionId)).toEqual([childId]);

      const steered = await f.door(
        {
          ...(role === "ticket"
            ? { role: "ticket" as const, ticketId: f.ticketId! }
            : { role: "project" as const, ticketId: null }),
          sessionId: parent.sessionId,
          projectId: "project-1",
          rootThreadId: sessionRootThreadId(parent.sessionId),
          attachmentId: parentAttachment.id,
        },
        {
          verb: "session.send",
          toolCallId: "steer-1",
          input: { session: shortSessionId(childId), message: "Also check the fixture page title" },
        },
        new AbortController().signal,
      );
      expect(steered.text).toContain("Delivered into Session");
      expect(steered.text).toContain("mid-stream");
      // Steering opens no turn in the sender, and nothing is answered while the
      // child is still working.
      expect(await parentTurnActive()).toBe(false);
      expect(await noticeReceipts()).toEqual([]);

      // Released: the child reads the steer at its next step of the same turn,
      // answers, and that one turn's end is the delegation's one notice.
      f.browser.loadGate = null;
      gate.resolve();
      unblockLoad = undefined;
      await vi.waitFor(async () => {
        expect(await noticeReceipts()).toMatchObject([
          {
            payload: {
              receipt: {
                status: "accepted",
                commandId: `delegate-1${DELEGATION_ID_SUFFIXES.notice}`,
              },
            },
          },
        ]);
        expect(await parentTurnActive()).toBe(false);
      });

      // Drain the actual Watch registry's coalescing window too. The send door
      // must not add a second host notice beside the delegation's own answer.
      await f.flushWatchNotices();
      const parentMessages = (await f.engine.listEvents({ sessionId: parent.sessionId })).filter(
        ({ payload }) =>
          payload.kind === "command.recorded" &&
          payload.command.intent.kind === "message.submit" &&
          payload.command.id !== "parent:first",
      );
      expect(parentMessages).toMatchObject([
        { payload: { command: { id: `delegate-1${DELEGATION_ID_SUFFIXES.notice}` } } },
      ]);
      expect(steered.text).toContain("Its delegation answer reports back");
      expect(f.watches.watching(parent.sessionId).sessions).toEqual([]);

      // What the child read: the marker naming the parent, then the parent's
      // words — never a plain message from its own user.
      const marker = supervisionMarker(parent.sessionId);
      const steeredSteps = f.script.requests.filter((request) =>
        JSON.stringify(request).includes(marker),
      );
      expect(steeredSteps).toHaveLength(1);
      expect(JSON.stringify(steeredSteps[0])).toContain("Also check the fixture page title");
      // What the parent read: its delegate's answer, under the one notice.
      expect(JSON.stringify(f.script.requests.at(-1))).toContain("| Child final answer");

      const childEvents = await f.engine.listEvents({ sessionId: childId });
      // The steer joined the kickoff's turn: it opened no second one.
      const childTurns = (kind: "turn.started" | "turn.completed") =>
        childEvents.filter(({ payload }) => payload.kind === kind).length;
      expect(childTurns("turn.started")).toBe(1);
      expect(childTurns("turn.completed")).toBe(1);
      const steerEvent = childEvents.find(
        ({ payload }) =>
          payload.kind === "command.recorded" &&
          payload.command.id === `${parent.sessionId}:steer-1`,
      );
      if (steerEvent === undefined || steerEvent.payload.kind !== "command.recorded")
        throw new Error("the steer never reached the child's ledger");
      if (steerEvent.payload.command.intent.kind !== "message.submit")
        throw new Error("the steer was recorded as something other than a message");
      // The child's own history holds the marked text its model read.
      const recorded = await f.artifacts.read(steerEvent.payload.command.intent.reference);
      expect(recorded.message.parts).toMatchObject([
        { type: "text", text: expect.stringContaining(marker) },
      ]);

      expect((await f.host.projection({ sessionId: childId })).projection).toMatchObject({
        turnActive: false,
        lastTurnOutcome: "completed",
        // A Ticket Session's delegate carries the Ticket but is not one itself.
        session: { role: "subagent", parentSessionId: parent.sessionId, ticketId: f.ticketId },
      });
      expect(f.delegations.watching(childId)).toBe(false);
      expect(f.delegations.liveChildren(parent.sessionId)).toEqual([]);
      expect(f.reports).toEqual([]);
      // The parent's own message and the kickoff; the notice rides the runtime.
      expect(f.submitSessionMessage).toHaveBeenCalledTimes(2);
      // One turn to ask, one turn to read the answer. Nothing else woke it.
      expect(
        (await f.engine.listEvents({ sessionId: parent.sessionId })).filter(
          ({ payload }) => payload.kind === "turn.started",
        ),
      ).toHaveLength(2);
    },
  );
});

const startShell = (command: string): ScriptedReply => ({
  tool: { name: "shell_start", args: { command } },
});
/**
 * The pids `shell_start` reported, one per call, in the order first seen. The
 * spawned shell leads its own group, and the pid is known at the spawn — so
 * nothing races the turn's end the way a pid file the shell writes would.
 */
function startedPids(requests: ReturnType<typeof fixture>["script"]["requests"]): number[] {
  const byCall = new Map<string, number>();
  for (const message of requests.flat()) {
    if (message.role !== "toolResult") continue;
    const match = /Started background shell \S+ \(pid (\d+)\)/.exec(
      JSON.stringify(message.content),
    );
    if (match !== null && !byCall.has(message.toolCallId))
      byCall.set(message.toolCallId, Number(match[1]));
  }
  return [...byCall.values()];
}
/** Whether any process of the group `pid` leads is still alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Real processes: the shell host spawns them in their own groups, as in a build.
describe("completed delegate background shell cleanup (VC-809)", () => {
  it("kills a delegate's shells with its attachment open, silently, and keeps a project's", async () => {
    const notices: BackgroundShellNotice[] = [];
    const shells = (shellHost = new BackgroundShellHost({
      publishState: () => undefined,
      publishRemoved: () => undefined,
      onNotice: (notice) => notices.push(notice),
      exitNoticeGraceMs: 10,
      settleMs: 50,
      killGraceMs: 200,
    }));
    const f = fixture("project", { shells });
    const parent = await f.start({
      operationId: "parent",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      title: "Parent",
    });
    const child = await f.start({
      operationId: "child",
      projectId: "project-1",
      ticketId: null,
      role: "subagent",
      parentSessionId: parent.sessionId,
      title: "Helper",
    });
    f.replies.splice(
      0,
      f.replies.length,
      startShell("exec sleep 300"),
      { text: "Parent ready" },
      startShell("exec sleep 300"),
      { text: "Child answer" },
      startShell("exec sleep 300"),
      { text: "Child again" },
    );
    await f.submitSessionMessage({
      sessionId: parent.sessionId,
      commandId: "parent:first",
      messageId: "parent:first-message",
      text: "Start a server",
    });
    await f.submitSessionMessage({
      sessionId: child.sessionId,
      commandId: "child:first",
      messageId: "child:first-message",
      text: "Start a server and check it",
    });
    const { projection } = await f.host.projection({ sessionId: child.sessionId });
    expect(projection.lastTurnOutcome).toBe("completed");
    expect(projection.liveExecutor?.status).toBe("open");
    expect(shells.list(child.sessionId)).toEqual([]);
    const [parentPid, first] = startedPids(f.script.requests);
    expect(first).toBeTypeOf("number");
    await vi.waitFor(() => expect(groupAlive(first!)).toBe(false), { timeout: 5_000 });
    // A Board or Ticket Session's shells outlive its turn, as before.
    expect(shells.list(parent.sessionId)).toMatchObject([{ state: "running" }]);
    expect(groupAlive(parentPid!)).toBe(true);

    // A person resuming it gets a working shell port, retired again at the end.
    await f.submitSessionMessage({
      sessionId: child.sessionId,
      commandId: "child:resume",
      messageId: "child:resume-message",
      text: "Once more",
    });
    expect(shells.list(child.sessionId)).toEqual([]);
    const second = startedPids(f.script.requests)[2];
    expect(second).toBeTypeOf("number");
    await vi.waitFor(() => expect(groupAlive(second!)).toBe(false), { timeout: 5_000 });
    const toolResults = f.script.requests.flatMap((request) =>
      request.filter((message) => message.role === "toolResult"),
    );
    // Each request carries its Session's whole history, so count calls once.
    expect(new Set(toolResults.map((message) => message.toolCallId)).size).toBe(3);
    expect(toolResults.every((message) => !message.isError)).toBe(true);

    // Volli's kill is not news: no exit notice reaches the answered child.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notices).toEqual([]);
    const events = await f.engine.listEvents({ sessionId: child.sessionId });
    expect(events.filter(({ payload }) => payload.kind === "turn.started")).toHaveLength(2);
  });
});
