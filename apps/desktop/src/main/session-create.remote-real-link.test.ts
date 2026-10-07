// @vitest-environment node
/**
 * VC-722 PR B: the UI's + Chat door, Draft promotion and first Send over a
 * real Workspace HOST link. This lives beside VC-713's fixture because it
 * composes the Node listener/SQLite runtime and desktop IPC adapter; the
 * renderer's production boot/store/transport code is not replaced.
 *
 * Only the box's executor, Electron's IPC registration, renderer persistence
 * and window are doubles. No provider, Electron process or outward connection
 * is needed. HOST health cannot substitute for this Workspace's welcome.
 */
import { randomUUID } from "node:crypto";

import { boardResourceWorkspace } from "@volli/host-core/board";
import { insertProject, insertTicket } from "@volli/host-core/db";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import {
  openTestDb,
  createTestSessionEngine,
  testProject,
  testTicket,
} from "@volli/host-core/testing";
import { createSessionRuntime, createInMemoryTranscriptArtifactStore } from "@volli/session-engine";
import type { FlushHost } from "@volli/session-presentation";
import { createHostRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import type { ModelSelection } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { createSqliteSessionFollowUpLedger } from "../../../../packages/host-core/src/db/session-follow-up-repo";

import { chatTransportFor } from "@renderer/chat/transport";
import { bootChatSession } from "@renderer/components/sessions/session-create";
import { flushAllPendingAppState } from "@renderer/lib/app-state-storage";
import { relayHostLink } from "@renderer/lib/relay-host-link";
import { resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import { createRemoteSessionStreams } from "@renderer/lib/remote-session-streams";
import { bindRemoteSessions } from "@renderer/lib/remote-sessions";
import {
  remoteChatTransport,
  remoteListingReader,
  remoteSessionClient,
  sessionsUnavailableOn,
} from "@renderer/lib/remote-session-wire";
import { forgetSessionProject } from "@renderer/lib/session-project";
import { useBoardStore } from "@renderer/stores/board";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { createFakeHostSource, hostSnapshot, remoteHost } from "@renderer/stores/host-sources";
import { useProjectsStore } from "@renderer/stores/projects";
import { projectScope, ticketScope } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { createRemoteSessionAvailabilityStore } from "@renderer/stores/remote-session-availability";
import {
  bindingWindow,
  CREDENTIAL,
  desktopMain,
  DEVICE,
  HOST,
  manualClock,
  PROJECT,
  relayAsks,
  ScriptedExecutor,
  storeState,
  thisMacWindow,
  untilState,
  window as rendererWindow,
  workspaceLink,
  type Cleanups,
} from "./remote-sessions.real-link.test-support";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      void electron.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      void electron.listeners.set(channel, listener),
  },
}));
// Main's afterEach imports this coalescer. It must not resolve BrowserWindow.
vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@renderer/terminal/registry", () => ({
  disposeEngine: vi.fn(),
  getOrCreateEngine: vi.fn(),
}));

const FEATURES = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "sessions.listing",
] as const;
const HOST_NAME = "chat-box";
const MODEL: ModelSelection = {
  providerId: "box",
  modelId: "box-default",
  reasoningLevel: "medium",
};
const LOCAL_MODEL: ModelSelection = {
  providerId: "this-mac",
  modelId: "local-pin",
  reasoningLevel: "high",
};
const project = testProject({ id: PROJECT, name: "On the box", path: "/srv/repo" });
const ticket = testTicket(PROJECT, {
  id: "39a1d6cb-b065-46c4-8187-232b1e086df3",
  usesWorktree: false,
});
const WAIT = { timeout: 5_000, interval: 10 };
const cleanups: Cleanups = [];
const originals = {
  chats: useChatSessionsStore.getState(),
  drafts: useChatDraftsStore.getState(),
  board: useBoardStore.getState(),
  projects: useProjectsStore.getState(),
  experiments: useExperimentsStore.getState(),
  tickets: useTicketSessionRecordsStore.getState(),
};
// One window bridge per file: the renderer's local RPC client memoizes it.
const thisMac = thisMacWindow();
const persistence = vi.fn(async () => ({ ok: true as const }));
// A Node timer backs the browser scheduler's numeric handle contract.
const flushHost: FlushHost = {
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  setTimeout: (run, ms) => setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

beforeEach(() => {
  vi.clearAllMocks();
  thisMac.calls.length = 0;
  vi.stubGlobal("window", {
    ...thisMac.window,
    api: { ...thisMac.window.api, appState: { set: persistence } },
  });
  useChatSessionsStore.setState(originals.chats, true);
  useChatDraftsStore.setState({ ...originals.drafts, drafts: {} }, true);
  useProjectsStore.setState({ ...originals.projects, projects: [project] }, true);
  useBoardStore.setState({ ...originals.board, ticketsByProject: { [PROJECT]: [ticket] } }, true);
  useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
});
afterEach(async () => {
  // Close clients before stopping the binding, so teardown cannot re-home one
  // onto a local transport or leave a stream running past listener disposal.
  for (const id of Object.keys(useChatSessionsStore.getState().sessions)) {
    useChatSessionsStore.getState().closeChatSession(id);
    forgetSessionProject(id);
  }
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  useChatSessionsStore.setState(originals.chats, true);
  useChatDraftsStore.setState(originals.drafts, true);
  useBoardStore.setState(originals.board, true);
  useProjectsStore.setState(originals.projects, true);
  useExperimentsStore.setState(originals.experiments, true);
  useTicketSessionRecordsStore.setState(originals.tickets, true);
  await flushAllPendingAppState();
  resetRemoteOwnersForTest();
  electron.handlers.clear();
  electron.listeners.clear();
  vi.unstubAllGlobals();
});

/** Real host runtime; only its attachment executor and Role model policy are scripted. */
async function path(features: readonly string[] = FEATURES) {
  const ctx = openTestDb();
  cleanups.push(ctx.cleanup);
  insertProject(ctx.db, project);
  insertTicket(ctx.db, ticket);
  const engine = createTestSessionEngine(ctx.db);
  const executor = new ScriptedExecutor();
  let sequence = 0;
  const runtime = createSessionRuntime({
    engine,
    executor,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createSqliteSessionFollowUpLedger(ctx.db),
    locations: {
      resolve: async () => ({ directory: project.path, venue: { id: HOST, kind: "local" } }),
      prepare: async () => ({ directory: project.path, venue: { id: HOST, kind: "local" } }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => Date.now() },
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  cleanups.push(() => runtime.close());
  type Sessions = NonNullable<Parameters<typeof createHostHandlers>[1]["sessions"]>;
  const creates: Parameters<Sessions["create"]>[0][] = [];
  const sessions: Sessions = {
    async create(input) {
      creates.push(structuredClone(input));
      const created = await runtime.command({
        commandId: `${input.operationId}:create`,
        command: {
          kind: "session.create",
          projectId: input.projectId,
          ticketId: input.ticketId,
          role: input.role,
          parentSessionId: null,
          title: input.title,
          ...(input.requestedSessionId === undefined
            ? {}
            : { requestedSessionId: input.requestedSessionId }),
        },
      });
      const selected = await runtime.command({
        commandId: `${input.operationId}:model`,
        sessionId: created.sessionId,
        command: { kind: "model.select", selection: MODEL },
      });
      if (selected.receipt?.status !== "completed") throw new Error("Box model was not recorded");
      return { sessionId: created.sessionId, model: MODEL };
    },
    async attach(input) {
      const attached = await runtime.command({
        commandId: `${input.operationId}:attach`,
        sessionId: input.sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      const ready =
        attached.receipt?.status === "accepted" || attached.receipt?.status === "completed";
      return {
        sessionId: input.sessionId,
        state: ready ? "ready" : "needs-recovery",
        receipt: attached.receipt,
        throughSequence: attached.throughSequence,
      };
    },
  };
  const map = createHostHandlers(
    {
      events: { publish() {} },
      attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
    } as never,
    {
      db: ctx.db,
      dataDir: "",
      runtime,
      sessions,
      modelAccess: null,
      experiments: null,
      automations: {
        kind: "live",
        execution: { kind: "unavailable", pendingArmedRuns: { noteDeliberateMove() {} } },
      } as never,
      busyWorktreeSites: async () => [],
      sessionListing: {
        db: ctx.db,
        listSessions: (query) => engine.listSessions(query),
        liveAttachmentIds: () =>
          new Set(runtime.openNativeBindings().map((binding) => binding.attachmentId)),
      },
    },
  );
  const boardWorkspace = boardResourceWorkspace(ctx.db);
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 5388 },
    host: { id: HOST, version: "session-create-remote-real-link" },
    features,
    workspace: (id) => (id === PROJECT ? { id, epoch: 1 } : null),
    verifier: {
      verify: ({ credential }) =>
        credential === CREDENTIAL
          ? {
              actor: { kind: "device", deviceId: DEVICE, workspaceId: PROJECT },
              current: () => true,
            }
          : null,
    },
    context: () => ({
      handlers: admittedHandlers(map, ROUTER_POLICY) as never,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: async (resource: { kind: string; id: string }) =>
        resource.kind === "session"
          ? ((await engine.getSession({ sessionId: resource.id }))?.session.projectId ?? null)
          : boardWorkspace(resource),
    }),
  });
  cleanups.push(() => listener.close());
  const link = workspaceLink(listener.url, FEATURES, cleanups);
  await untilState(link, "ready");
  const main = await desktopMain(link, electron, cleanups);
  const win = rendererWindow(main);
  cleanups.push(() => win.close());
  // The grant comes from this Workspace's actual welcome, never the fixture's
  // list of requested features or the host's aggregate health.
  const state = link.getState();
  if (state.status !== "ready") throw new Error("Workspace is not ready");
  const snapshot = hostSnapshot([remoteHost(HOST, HOST_NAME)], { [PROJECT]: HOST });
  const source = createFakeHostSource({
    ...snapshot,
    projects: { [PROJECT]: { ...snapshot.projects[PROJECT]!, granted: state.welcome.features } },
  });
  cleanups.push(useHostConnectionStore.getState().attach(source));
  const availability = createRemoteSessionAvailabilityStore();
  const clock = manualClock();
  const bound = bindRemoteSessions({
    hosts: useHostConnectionStore,
    visibleProjects: () => [PROJECT],
    refreshListings: async () => {},
    rebindSessions: (ids) => useChatSessionsStore.getState().rebindChatSessions(ids),
    availability: availability.getState(),
    window: bindingWindow(),
    clock,
    workspace: (input) => {
      const client = remoteSessionClient(
        relayHostLink(input.projectId, { rpc: win.client, state: storeState(link) }),
        input.hostName,
      );
      const streams = createRemoteSessionStreams({ clock });
      return {
        projectId: input.projectId,
        client,
        streams,
        transport: remoteChatTransport(client, streams, flushHost),
        listing: remoteListingReader(client, input.notGranted),
        dispose: () => streams.dispose(),
      };
    },
  });
  cleanups.push(() => bound.stop());
  return { engine, runtime, executor, creates, link, win, bound };
}

describe(
  "remote + Chat through a real Workspace welcome (VC-722 PR B)",
  { timeout: 15_000 },
  () => {
    it.each(["project", "ticket"] as const)(
      "opens and promotes a %s Draft, then sends to the box with its default model",
      async (kind) => {
        const remote = await path();
        expect(chatTransportFor(PROJECT).streamRecovery).toBe("host-link");
        const scope = kind === "project" ? projectScope(PROJECT) : ticketScope(PROJECT, ticket.id);
        const land = vi.fn((id: string, isSession: boolean) => {
          useChatSessionsStore.getState().openChatTab(kind === "project" ? PROJECT : ticket.id, id);
          expect(isSession).toBe(false);
          return true;
        });
        const id = await bootChatSession(scope, { land });
        expect(toast.error).not.toHaveBeenCalled();
        expect(toast).not.toHaveBeenCalled();
        expect(id).not.toBeNull();
        if (id === null) throw new Error("Remote + Chat refused a granted Workspace");
        expect(land).toHaveBeenCalledWith(id, false);
        expect(useChatDraftsStore.getState().drafts[id]?.provisional).toMatchObject({
          projectId: PROJECT,
          ticketId: kind === "project" ? null : ticket.id,
          phase: "draft",
        });
        const operationId = useChatDraftsStore.getState().drafts[id]?.provisional?.operationId;
        expect(remote.creates).toEqual([]);
        expect(remote.win.requests).toEqual([]);
        expect(remote.executor.attaches).toBe(0);
        expect(thisMac.calls).toEqual([]);

        // The composer can freeze This Mac's configured default at Send. Remote
        // transport must strip both that pin and its automatic-selection hint.
        const message = { id: randomUUID(), text: "Hello from the remote UI door" };
        useChatDraftsStore.getState().setProvisionalModel(id, LOCAL_MODEL, { fromDefault: true });
        useChatDraftsStore.getState().holdMessage(id, message);
        await expect(useChatSessionsStore.getState().promoteChatSession(id)).resolves.toBe(true);
        expect(remote.creates).toHaveLength(1);
        expect(remote.creates[0]).toMatchObject({
          projectId: PROJECT,
          ticketId: kind === "project" ? null : ticket.id,
          requestedSessionId: id,
          operationId,
          title: null,
          role: kind === "project" ? "project" : "ticket",
        });
        expect(remote.creates[0]).not.toHaveProperty("modelOverride");
        expect(remote.creates[0]).not.toHaveProperty("model");
        expect(remote.creates[0]).not.toHaveProperty("autoSelect");
        expect((await remote.engine.getSession({ sessionId: id }))?.session).toMatchObject({
          id,
          projectId: PROJECT,
          ticketId: kind === "project" ? null : ticket.id,
          parentSessionId: null,
        });
        expect(
          (await remote.runtime.projection({ sessionId: id })).projection.modelSelection,
        ).toEqual(MODEL);
        const offscreen = remote.bound.show(PROJECT, id);
        cleanups.push(offscreen);
        await vi.waitFor(
          () => expect(useChatSessionsStore.getState().sessions[id]?.lifecycle).toBe("ready"),
          WAIT,
        );
        await expect(useChatSessionsStore.getState().enqueue(id, message)).resolves.not.toBe(
          "refused",
        );
        useChatDraftsStore.getState().completePromotion(id);
        await vi.waitFor(
          () => expect(remote.executor.commandKinds()).toContain("message.submit"),
          WAIT,
        );
        expect(remote.executor.attaches).toBe(1);
        expect(
          remote.executor.commands.find((command) => command.kind === "message.submit"),
        ).toMatchObject({
          sessionId: id,
          message: { parts: [{ type: "text", text: message.text }] },
        });
        expect(relayAsks(remote.win.requests, "sessions.create")).toBe(1);
        expect(relayAsks(remote.win.requests, "sessions.attach")).toBe(1);
        expect(relayAsks(remote.win.requests, "session.command")).toBeGreaterThan(0);
        // Local UI persistence is allowed; Session identities are not. Every
        // Session RPC is addressed through the hostLink envelope, never locally.
        expect(remote.win.requests.every((request) => request.path.startsWith("hostLink."))).toBe(
          true,
        );
        expect(thisMac.calls).toEqual([]);
        await remote.executor.turn("first-turn", "Hello from chat-box");
        await vi.waitFor(
          () =>
            expect(
              useChatSessionsStore
                .getState()
                .sessions[id]?.transcript.durableMessages.flatMap((entry) =>
                  entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
                ),
            ).toContain("Hello from chat-box"),
          WAIT,
        );
        expect(useChatSessionsStore.getState().sessions[id]?.projection?.modelSelection).toEqual(
          MODEL,
        );
        expect(useChatSessionsStore.getState().sessions[id]?.sessionError).toBeNull();
        expect(toast.error).not.toHaveBeenCalled();
        expect(thisMac.calls).toEqual([]);
      },
    );

    it("names an older box unavailable when its Workspace welcome grants no sessions", async () => {
      const remote = await path(["board.read"]);
      const land = vi.fn(() => true);
      await expect(bootChatSession(projectScope(PROJECT), { land })).resolves.toBeNull();
      expect(land).not.toHaveBeenCalled();
      expect(useChatDraftsStore.getState().drafts).toEqual({});
      expect(toast).toHaveBeenCalledWith(`Not available on ${HOST_NAME} yet`, {
        id: "host-local-only",
      });
      expect(relayAsks(remote.win.requests, "sessions.create")).toBe(0);
      // A direct transport caller cannot bypass the absent negotiated grant;
      // the real relay refuses it with the older host's named unavailable reason.
      await expect(
        chatTransportFor(PROJECT).createSession({
          operationId: randomUUID(),
          projectId: PROJECT,
          ticketId: null,
          title: null,
        }),
      ).rejects.toThrow(sessionsUnavailableOn(HOST_NAME));
      expect(remote.creates).toEqual([]);
      expect(remote.executor.attaches).toBe(0);
      expect(thisMac.calls).toEqual([]);
    });
  },
);
