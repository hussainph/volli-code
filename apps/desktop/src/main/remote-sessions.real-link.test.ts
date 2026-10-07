// @vitest-environment node
/**
 * A remote project's Sessions through the Workspace link relay, end to end
 * over a real link (VC-713):
 *
 * - **the box:** the production host protocol listener serving the composed
 *   host router over host-core's handler map, with a REAL Session runtime
 *   (`createSessionRuntime` over the host's SQLite Session engine) whose
 *   executor this test scripts, granting `sessions`, `sessions.queue`,
 *   `sessions.subscribe`, `sessions.history` and `sessions.listing`, with
 *   replay bounds small enough that a resume after an outage must re-read its
 *   snapshot, behind a loopback TCP route this test can cut;
 * - **desktop main:** VC-670's `createHostLink` to it, the relay over that
 *   link (`createHostLinkRelay`), the desktop's own handler map holding it,
 *   and main's real generic IPC bridge registration behind a fake `ipcMain`;
 * - **the window:** the bridge's real client link, the renderer's
 *   `relayHostLink`, and VC-713's own remote Session plumbing over it
 *   (`remoteSessionClient`, `remoteChatTransport`, `remoteListingReader`,
 *   `createRemoteSessionStreams`) under the real chat core
 *   (`getOrCreateChatClient` over the package's surface store).
 *
 * It proves the remote Session round trip: create over the relay, a scripted
 * turn streamed to the window, a question shown as "waiting" in the listing
 * and answered over the relay to the executor, and a link drop survived —
 * the resume past the box's replay bound re-reads the snapshot, with no
 * error band — after which the listing says "waiting" again. Nothing real
 * signs in or connects outward: every port is loopback.
 */
import { randomUUID } from "node:crypto";

import { boardResourceWorkspace } from "@volli/host-core/board";
import { insertProject } from "@volli/host-core/db";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { createTestSessionEngine, openTestDb, testProject } from "@volli/host-core/testing";
import { createLogRing } from "@volli/host-core/log";
import { runGitCapturing, runGitCapturingAsync } from "@volli/host-core/worktree";
import { createSessionRuntime, createInMemoryTranscriptArtifactStore } from "@volli/session-engine";
import {
  createSurfaceStore,
  disposeChatClient,
  getOrCreateChatClient,
  type ChatSessionSlice,
  type ChatSessionTransport,
  type FlushHost,
} from "@volli/session-presentation";
import { createHostRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import type { ModelSelection, SessionListingRow } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { relayHostLink } from "../renderer/src/lib/relay-host-link";
import { createRemoteSessionStreams } from "../renderer/src/lib/remote-session-streams";
import * as remote from "../renderer/src/lib/remote-session-wire";
import {
  CREDENTIAL,
  cuttableRoute,
  desktopMain,
  DEVICE,
  HOST,
  PROJECT,
  ScriptedExecutor,
  storeState,
  untilState,
  window,
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

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  electron.handlers.clear();
  electron.listeners.clear();
});

const FEATURES = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "sessions.listing",
] as const;

/** The model every Session on the box records at birth, as the host's default would. */
const MODEL: ModelSelection = {
  providerId: "scripted",
  modelId: "scripted-1",
  reasoningLevel: "medium",
};

/**
 * A resume may replay at most this many durable events; past it the box
 * answers `subscription-resnapshot-required` (hostd's bound is in bytes, far
 * larger; the rule is the same).
 */
const MAX_REPLAY_EVENTS = 3;

// ---- the box -------------------------------------------------------------------

async function box() {
  const ctx = openTestDb();
  cleanups.push(() => ctx.cleanup());
  insertProject(
    ctx.db,
    testProject({ id: PROJECT, name: "On the box", ticketPrefix: "BX", path: "/srv/repo" }),
  );
  const engine = createTestSessionEngine(ctx.db);
  const executor = new ScriptedExecutor();
  let sequence = 0;
  const runtime = createSessionRuntime({
    engine,
    executor,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: {
      resolve: async () => ({ directory: "/srv/repo", venue: { id: HOST, kind: "local" } }),
      prepare: async () => ({ directory: "/srv/repo", venue: { id: HOST, kind: "local" } }),
      reaffirm: async () => undefined,
    },
    clock: { now: () => Date.now() },
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  cleanups.push(() => runtime.close());

  // The host's Sessions facade, minimal: mint and record the default model,
  // then attach — what `Sessions.create`/`attach` do, without prompt
  // resources, worktrees or a model catalog.
  const sessions: NonNullable<Parameters<typeof createHostHandlers>[1]["sessions"]> = {
    async create(input) {
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
      if (selected.receipt?.status !== "completed") throw new Error("The model was not recorded");
      return { sessionId: created.sessionId, model: MODEL };
    },
    async attach(input) {
      const attached = await runtime.command({
        commandId: `${input.operationId}:start`,
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
      events: { publish: () => {} },
      attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
    } as unknown as Parameters<typeof createHostHandlers>[0],
    {
      db: ctx.db,
      dataDir: "",
      runtime,
      sessions,
      modelAccess: null,
      experiments: null,
      automations: {
        kind: "live",
        execution: { kind: "unavailable", pendingArmedRuns: { noteDeliberateMove: () => {} } },
      } as unknown as Parameters<typeof createHostHandlers>[1]["automations"],
      busyWorktreeSites: async () => [],
      logs: createLogRing(),
      worktree: { db: ctx.db, git: runGitCapturing, gitAsync: runGitCapturingAsync, blobsRoot: "" },
      sessionListing: {
        db: ctx.db,
        listSessions: (query) => engine.listSessions(query),
        liveAttachmentIds: () =>
          new Set(runtime.openNativeBindings().map((binding) => binding.attachmentId)),
      },
    },
  );

  // Each Session stream open on the box, counted as the router opens and ends it.
  const admitted = admittedHandlers(map, ROUTER_POLICY);
  const sessionStreams = new Set<object>();
  const counted =
    (key: "session.subscribe" | "session.subscribeQueue"): (typeof admitted)[typeof key] =>
    async (input, call, sink) => {
      const stop = await admitted[key](input, call, sink);
      const stream = {};
      sessionStreams.add(stream);
      return () => {
        sessionStreams.delete(stream);
        stop();
      };
    };
  const handlers = {
    ...admitted,
    "session.subscribe": counted("session.subscribe"),
    "session.subscribeQueue": counted("session.subscribeQueue"),
  };

  const boardWorkspace = boardResourceWorkspace(ctx.db);
  const diagnostics = new RpcDiagnosticLog();
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "remote-sessions-real-link" },
    features: FEATURES,
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
    limits: { maxReplayEvents: MAX_REPLAY_EVENTS },
    context: () => ({
      handlers: handlers as never,
      diagnostics,
      resourceWorkspace: async (resource: { kind: string; id: string }) =>
        resource.kind === "session"
          ? ((await engine.getSession({ sessionId: resource.id }))?.session.projectId ?? null)
          : boardWorkspace(resource),
    }),
  });
  cleanups.push(() => listener.close());
  return { db: ctx.db, engine, runtime, executor, url: listener.url, sessionStreams };
}

// ---- the window ----------------------------------------------------------------

/** Frame callbacks never run (an occluded window); the timer half of the race folds. */
const flushHost: FlushHost = {
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: (run, ms) => setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

/** One whole path: the box, main's link and relay, and a window's remote Session plumbing. */
async function remoteProject() {
  const host = await box();
  const route = await cuttableRoute(host.url, cleanups);
  const link = workspaceLink(route.url, FEATURES, cleanups);
  await untilState(link, "ready");
  const main = await desktopMain(link, electron, cleanups);
  const win = window(main);
  cleanups.push(() => win.close());
  const relayed = relayHostLink(PROJECT, {
    rpc: win.client,
    state: storeState(link),
    resumeDelaysMs: [10, 20],
  });
  const client = remote.remoteSessionClient(relayed);
  const streams = createRemoteSessionStreams({
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  cleanups.push(() => streams.dispose());
  const transport = remote.remoteChatTransport(client, streams, flushHost);
  // Every snapshot the chat core reads, counted: a resnapshot is a second one.
  let snapshots = 0;
  const { snapshot } = transport.rpc.session;
  const counting: ChatSessionTransport = {
    ...transport,
    rpc: {
      session: {
        ...transport.rpc.session,
        snapshot: {
          query: (input) => {
            snapshots += 1;
            return snapshot.query(input);
          },
        },
      },
    },
  };
  return {
    host,
    route,
    link,
    main,
    streams,
    transport: counting,
    listing: remote.remoteListingReader(client),
    snapshots: () => snapshots,
  };
}

const textsOf = (slice: ChatSessionSlice | undefined): string[] =>
  (slice?.transcript.durableMessages ?? []).flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );

async function rowOf(
  listing: Awaited<ReturnType<typeof remoteProject>>["listing"],
  sessionId: string,
): Promise<Extract<SessionListingRow, { kind: "chat" }>["record"] | undefined> {
  const result = await listing.list({ projectId: PROJECT });
  if (!result.ok) throw new Error(result.error);
  const row = result.sessions.find(
    (candidate) => candidate.kind === "chat" && candidate.record.sessionId === sessionId,
  );
  return row?.kind === "chat" ? row.record : undefined;
}

const question = (id: string, title: string) =>
  ({
    kind: "interaction",
    state: "opened",
    occurredAt: Date.now(),
    interaction: {
      id,
      kind: "question",
      title,
      detail: null,
      options: [
        { id: "yes", label: "Yes", description: null },
        { id: "no", label: "No", description: null },
      ],
      multiple: false,
      native: { id: null, detail: null },
    },
  }) as const;

const WAIT = { timeout: 5_000, interval: 10 };

describe("a remote project's Sessions through the relay, over a real link", () => {
  it("creates, streams a turn, answers a question, and survives a drop with a resnapshot", async () => {
    const { host, route, link, main, streams, transport, listing, snapshots } =
      await remoteProject();
    const store = createSurfaceStore();
    const notices: string[] = [];

    // 1. A Session created over the relay exists on the box, attached to the
    // scripted executor, and the window follows it on screen.
    const { sessionId } = await transport.createSession({
      operationId: randomUUID(),
      projectId: PROJECT,
      ticketId: null,
      title: "From this Mac",
    });
    expect((await host.engine.getSession({ sessionId }))?.session).toMatchObject({
      projectId: PROJECT,
      title: "From this Mac",
    });
    store.getState().seed(sessionId, "starting");
    const chat = getOrCreateChatClient(sessionId, {
      ...transport,
      store,
      notify: (message) => void notices.push(message),
      renameSession: () => {},
    });
    cleanups.push(() => disposeChatClient(sessionId));
    const offScreen = streams.show(sessionId);
    cleanups.push(offScreen);
    expect(await chat.startAttach()).toBe(true);
    expect(host.executor.attaches).toBe(1);
    const slice = () => store.getState().sessions[sessionId];
    await vi.waitFor(() => {
      expect(slice()?.projection?.liveExecutor).not.toBeNull();
      expect(slice()?.lifecycle).toBe("ready");
      expect(host.sessionStreams.size).toBe(1);
    }, WAIT);
    expect(main.relay.open(PROJECT)).toBe(1);

    // A scripted turn: the person's message goes to the executor over the
    // relay, and what the executor says streams back to the window.
    expect(await chat.submit({ id: randomUUID(), text: "Hello, box" })).toBe("delivered");
    await vi.waitFor(() => expect(host.executor.commandKinds()).toContain("message.submit"), WAIT);
    await host.executor.turn("turn-1", "Hello from the box.");
    await vi.waitFor(() => expect(textsOf(slice())).toContain("Hello from the box."), WAIT);
    expect(textsOf(slice())).toContain("Hello, box");

    // 2. The executor asks a question: the listing says the Session waits on
    // the person; the answer goes over the relay to the executor.
    await host.executor.emit(question("question-1", "Ship it?"));
    expect(await rowOf(listing, sessionId)).toMatchObject({
      activity: "waiting",
      waitingOn: "question",
      live: true,
    });
    await vi.waitFor(
      () =>
        expect(slice()?.projection?.interactions.active.map(({ id }) => id)).toEqual([
          "question-1",
        ]),
      WAIT,
    );
    expect(
      await chat.resolveInteraction("question-1", { optionIds: ["yes"], response: null }),
    ).toBe(true);
    expect(host.executor.commands.at(-1)).toMatchObject({
      kind: "interaction.resolve",
      interaction: { id: "question-1" },
      resolution: { optionIds: ["yes"], response: null },
    });
    await host.executor.emit({
      kind: "interaction",
      state: "resolved",
      occurredAt: Date.now(),
      interactionId: "question-1",
      resolution: { optionIds: ["yes"], response: null },
    });
    expect(await rowOf(listing, sessionId)).toMatchObject({ waitingOn: null });
    expect((await rowOf(listing, sessionId))?.activity).not.toBe("waiting");
    await vi.waitFor(() => expect(slice()?.projection?.interactions.active).toEqual([]), WAIT);

    // 3. The link drops. While this Mac is away the box goes on: a whole turn
    // and a new question, more than one resume may replay.
    const before = snapshots();
    route.cut();
    await untilState(link, "unreachable");
    await vi.waitFor(() => expect(main.relay.open(PROJECT)).toBe(0), WAIT);
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(0), WAIT);
    await host.executor.turn("turn-2", "Written while you were away.");
    await host.executor.emit(question("question-2", "Still there?"));
    const head = (await host.runtime.projection({ sessionId })).throughSequence;
    expect(head - slice()!.transcript.throughSequence).toBeGreaterThan(MAX_REPLAY_EVENTS);

    route.unblock();
    await untilState(link, "ready");
    // The relay resumed after its last id, the box refused a replay that
    // long, and the chat core re-read the snapshot: everything written while
    // away is on screen, with no error band.
    await vi.waitFor(() => {
      expect(textsOf(slice())).toContain("Written while you were away.");
      expect(slice()?.projection?.interactions.active.map(({ id }) => id)).toEqual(["question-2"]);
    }, WAIT);
    expect(snapshots()).toBeGreaterThan(before);
    expect(slice()?.sessionError).toBeNull();
    expect(notices).toEqual([]);
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(1), WAIT);
    // And the listing read after the reconnect says it waits on the person again.
    expect(await rowOf(listing, sessionId)).toMatchObject({
      activity: "waiting",
      waitingOn: "question",
    });

    // It keeps following live after the resnapshot.
    await host.executor.turn("turn-3", "And after the drop.");
    await vi.waitFor(() => expect(textsOf(slice())).toContain("And after the drop."), WAIT);

    // 4. Off screen and let go: nothing stays open on the box or in main.
    offScreen();
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(0), WAIT);
    expect(main.relay.open(PROJECT)).toBe(0);
    disposeChatClient(sessionId);
    streams.dispose();
    expect(host.sessionStreams.size).toBe(0);
    expect(slice()?.sessionError).toBeNull();
  });
});
