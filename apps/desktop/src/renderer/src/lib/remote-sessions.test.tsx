// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type SessionListingRow,
  type Ticket,
} from "@volli/shared";
import type { ChatSessionTransport } from "@volli/session-presentation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatTransportFor, sessionCommandFor } from "@renderer/chat/transport";
import { useBoardStore } from "@renderer/stores/board";
import {
  createHostConnectionStore,
  useHostConnectionStore,
} from "@renderer/stores/host-connection";
import {
  createFakeHostSource,
  hostSnapshot,
  remoteHost,
  type FakeHostSource,
} from "@renderer/stores/host-sources";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { createRemoteSessionAvailabilityStore } from "@renderer/stores/remote-session-availability";
import { resetRemoteOwnersForTest } from "./remote-owners";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import { REMOTE_LISTING_POLL_MS } from "./remote-listing-refresh";
import {
  bindRemoteSessions,
  bindRemoteSessionsWhileCloud,
  listingRowsFromWire,
  relayedWorkspace,
  remoteChatTransport,
  remoteListingReader,
  remoteSessions,
  useRemoteSessionOnScreen,
  windowRemoteSessionsDeps,
  type RemoteSessionClient,
  type RemoteSessionsDeps,
  type RemoteWorkspace,
} from "./remote-sessions";
import {
  sessionListingReaderForProject,
  sessionListingReaderForTicket,
} from "./session-listing-reader";

const HOST = "host-box";
const chatRow = (sessionId: string): SessionListingRow => ({
  kind: "chat",
  record: {
    sessionId,
    title: sessionId,
    projectId: "remote",
    ticketId: null,
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "waiting",
    waitingOn: "question",
    outcome: null,
    lastActivityAt: 2,
    bornTicketless: true,
    role: "project",
    parentSessionId: null,
    model: null,
  },
  usage: EMPTY_SESSION_USAGE_SUMMARY,
  provenance: PERSON_STARTED,
});

function fakeClient() {
  const mutate = vi.fn(async (input: unknown) => input);
  const query = vi.fn();
  const subscribe = { subscribe: vi.fn() };
  const procedure = { query, mutate, subscribe: subscribe.subscribe };
  const client = {
    session: new Proxy({}, { get: () => procedure }),
    sessions: { create: { mutate }, attach: { mutate } },
  } as unknown as RemoteSessionClient;
  return { client, mutate, query, procedure };
}

describe("the remote chat transport (VC-713)", () => {
  it("creates with the host's default model and the Draft's own id, over the host-link recovery", async () => {
    const { client, mutate } = fakeClient();
    const wrap = vi.fn((source) => ({ wrapped: source }));
    const transport = remoteChatTransport(client, { wrap } as never, window);
    expect(transport.streamRecovery).toBe("host-link");
    expect(wrap).toHaveBeenCalledTimes(2);
    expect(transport.newCommandId()).not.toBe(transport.newCommandId());
    await transport.createSession({
      operationId: "op",
      projectId: "remote",
      ticketId: "t",
      title: "T",
      requestedSessionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      skills: ["code-review"],
      model: { providerId: "anthropic", modelId: "m", reasoningLevel: "high" },
      autoSelect: { request: "hi" },
    });
    await transport.createSession({
      operationId: "op2",
      projectId: "remote",
      ticketId: null,
      title: null,
    });
    await transport.attachSession({ operationId: "op3", sessionId: "s" });
    expect(mutate.mock.calls).toEqual([
      [
        {
          operationId: "op",
          projectId: "remote",
          ticketId: "t",
          title: "T",
          requestedSessionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
          skills: ["code-review"],
        },
      ],
      [{ operationId: "op2", projectId: "remote", ticketId: null, title: null }],
      [{ operationId: "op3", sessionId: "s" }],
    ]);
  });
});

/** A terminal row as the wire carries it: its harness ids are plain strings. */
const terminal = (harnessId: string, activeHarnessId: string | null) => ({
  kind: "terminal" as const,
  record: {
    id: "pty",
    projectId: "remote",
    ticketId: null,
    harnessId,
    activeHarnessId,
    harnessSessionId: null,
    launchKind: "agent" as const,
    placement: "tab" as const,
    title: "t",
    cwd: "/",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 1,
    bornTicketless: true,
  },
  usage: EMPTY_SESSION_USAGE_SUMMARY,
  provenance: PERSON_STARTED,
});

describe("the remote listing reader (VC-713)", () => {
  it("reads a project's and a ticket's rows, and says a failure instead of throwing", async () => {
    const { client, query } = fakeClient();
    const reader = remoteListingReader(client, () => {});
    query.mockResolvedValueOnce({ sessions: [chatRow("a")], omitted: 0 });
    expect(await reader.list({ projectId: "remote" })).toEqual({
      ok: true,
      sessions: [chatRow("a")],
    });
    query.mockResolvedValueOnce({ sessions: [], omitted: 0 });
    expect(await reader.listForTicket({ ticketId: "t" })).toEqual({ ok: true, sessions: [] });
    query.mockRejectedValueOnce(new Error("link dropped"));
    expect(await reader.list({ projectId: "remote" })).toEqual({
      ok: false,
      error: "link dropped",
    });
  });

  it("reads a terminal row's harness as this build knows it, and leaves out one it cannot name", () => {
    const rows = listingRowsFromWire([
      terminal("codex", null),
      terminal("my-harness", "codex"),
      terminal("Not A Slug", null),
      chatRow("c"),
    ]);
    expect(
      rows.map((row) => (row.kind === "chat" ? row.record.sessionId : row.record.harnessId)),
    ).toEqual(["codex", "my-harness", "c"]);
    expect(rows[1]).toMatchObject({ record: { activeHarnessId: "codex" } });
  });
});

/** A view that shows Session s1 of a project while it is mounted. */
function View({ projectId }: { projectId: string | null }) {
  useRemoteSessionOnScreen(projectId, "s1");
  return null;
}

describe("binding remote Sessions (VC-713)", () => {
  let hosts: ReturnType<typeof createHostConnectionStore>;
  let source: FakeHostSource;
  let workspaces: Map<string, RemoteWorkspace & { dispose: ReturnType<typeof vi.fn> }>;
  let notGranted: Map<string, () => void>;
  let rebinds: string[][];
  let availability: ReturnType<typeof createRemoteSessionAvailabilityStore>;
  let refreshed: string[];
  let shown: string[];
  let documentState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    hosts = createHostConnectionStore();
    source = createFakeHostSource(
      hostSnapshot([remoteHost(HOST, "box")], { remote: HOST, other: HOST }),
    );
    hosts.getState().attach(source);
    workspaces = new Map();
    notGranted = new Map();
    rebinds = [];
    availability = createRemoteSessionAvailabilityStore();
    useBoardStore.setState({
      ticketsByProject: {
        remote: [{ id: "remote-ticket" } as Ticket],
        local: [{ id: "local-ticket" } as Ticket],
      },
    });
    refreshed = [];
    shown = [];
    documentState = "visible";
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRemoteOwnersForTest();
    useBoardStore.setState({ ticketsByProject: {} });
  });

  function deps(overrides: Partial<RemoteSessionsDeps> = {}): RemoteSessionsDeps {
    const events = new EventTarget();
    const documentEvents = new EventTarget();
    return {
      hosts,
      visibleProjects: () => ["remote"],
      refreshListings: async (projectId) => void refreshed.push(projectId),
      workspace: ({ projectId, notGranted: refused }) => {
        notGranted.set(projectId, refused);
        const workspace = {
          projectId,
          client: {
            session: {
              command: {
                mutate: async () => {
                  throw new Error(`commanded on ${projectId}`);
                },
              },
            },
          } as unknown as RemoteWorkspace["client"],
          transport: { streamRecovery: "host-link" } as ChatSessionTransport,
          listing: { list: vi.fn(), listForTicket: vi.fn() },
          streams: {
            wrap: vi.fn(),
            show: (sessionId: string) => {
              shown.push(sessionId);
              return () => shown.push(`-${sessionId}`);
            },
            dispose: vi.fn(),
          },
          dispose: vi.fn(),
        };
        workspaces.set(projectId, workspace);
        return workspace;
      },
      rebindSessions: (projectIds) => void rebinds.push([...projectIds]),
      availability: availability.getState(),
      window: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        document: {
          get visibilityState() {
            return documentState;
          },
          addEventListener: documentEvents.addEventListener.bind(documentEvents),
          removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
          dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
        },
      } as unknown as RemoteSessionsDeps["window"],
      clock: {
        now: () => Date.now(),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      ...overrides,
    };
  }

  it("routes a remote project's chat and listing to its Workspace, and This Mac's to IPC", () => {
    const bound = bindRemoteSessions(deps());
    try {
      expect(chatTransportFor("remote").streamRecovery).toBe("host-link");
      expect(chatTransportFor("remote")).toBe(chatTransportFor("remote"));
      expect(sessionListingReaderForProject("remote")).toBe(workspaces.get("remote")!.listing);
      expect(sessionListingReaderForTicket("remote-ticket")).toBe(
        workspaces.get("remote")!.listing,
      );
      // A project no host claims, and a ticket on no board, are This Mac's.
      expect(sessionListingReaderForProject("local")).not.toBe(workspaces.get("remote")!.listing);
      expect(sessionListingReaderForTicket("local-ticket")).not.toBe(
        workspaces.get("remote")!.listing,
      );
      expect(sessionListingReaderForTicket("orphan-ticket")).not.toBe(
        workspaces.get("remote")!.listing,
      );
      vi.stubGlobal("window", {
        ...window,
        api: { sessionRpc: { request: vi.fn(), onEvent: () => () => {}, cancel: vi.fn() } },
      });
      expect(chatTransportFor("local").streamRecovery).toBeUndefined();
      expect([...workspaces.keys()]).toEqual(["remote"]);
    } finally {
      bound.stop();
      vi.unstubAllGlobals();
    }
  });

  it("says which remote Session is on screen to its Workspace's streams", () => {
    const bound = bindRemoteSessions(deps());
    const release = bound.show("remote", "s1");
    bound.show("local", "s2")();
    release();
    expect(shown).toEqual(["s1", "-s1"]);
    bound.stop();
    bound.stop();
    bound.show("remote", "s3")();
    expect(shown).toEqual(["s1", "-s1"]);
  });

  it("re-reads on focus, on visibility, on a reconnect, and on the poll of the project on screen", async () => {
    const options = deps();
    const bound = bindRemoteSessions(options);
    bound.show("remote", "s1");
    (options.window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    expect(refreshed.toSorted()).toEqual(["other", "remote"]);
    refreshed = [];
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(refreshed).toEqual(["remote"]);
    refreshed = [];
    // Hidden, then shown again: a read on the way back.
    documentState = "hidden";
    const doc = options.window.document as unknown as EventTarget;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refreshed).toEqual([]);
    documentState = "visible";
    await vi.advanceTimersByTimeAsync(10_000);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(refreshed.toSorted()).toEqual(["other", "remote"]);
    refreshed = [];
    // A link that drops and comes back is read the moment it is ready.
    await vi.advanceTimersByTimeAsync(10_000);
    source.setProjectLink("other", { status: "offline", since: 0, retryAt: null });
    source.setProjectLink("other", { status: "open" });
    expect(refreshed).toEqual(["other"]);
    bound.stop();
    (options.window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    expect(refreshed).toEqual(["other"]);
  });

  it("lets go of a Workspace whose project stops being remote, and of every one on stop", () => {
    const bound = bindRemoteSessions(deps());
    chatTransportFor("remote");
    chatTransportFor("other");
    const remote = workspaces.get("remote")!;
    source.set(hostSnapshot([remoteHost(HOST, "box")], { other: HOST }));
    expect(remote.dispose).toHaveBeenCalledOnce();
    bound.stop();
    expect(workspaces.get("other")!.dispose).toHaveBeenCalledOnce();
    // Nothing is registered any more: the project is This Mac's to the chat store.
    expect(workspaces.get("other")!.transport).not.toBe(undefined);
    expect(sessionListingReaderForProject("other")).not.toBe(workspaces.get("other")!.listing);
  });

  it("cancels a forgotten project's pending re-read, and reads nothing more for it (N1)", async () => {
    const options = deps();
    const bound = bindRemoteSessions(options);
    const target = options.window as unknown as EventTarget;
    target.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    // Inside the window: one trailing re-read each is pending.
    target.dispatchEvent(new Event("focus"));
    expect(refreshed.toSorted()).toEqual(["other", "remote"]);
    source.set(hostSnapshot([remoteHost(HOST, "box")], { remote: HOST }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshed.toSorted()).toEqual(["other", "remote", "remote"]);
    bound.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends everything it owns when the window goes", async () => {
    const options = deps();
    bindRemoteSessions(options);
    chatTransportFor("remote");
    const target = options.window as unknown as EventTarget;
    target.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
    expect(workspaces.get("remote")!.dispose).toHaveBeenCalledOnce();
    target.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshed.toSorted()).toEqual(["other", "remote"]);
  });

  it("keeps a project known remote after its claim goes: closed in the host's name, never IPC (B1)", async () => {
    const bound = bindRemoteSessions(deps());
    // Bound, its Island Stop goes to the Workspace's own client.
    await expect(
      sessionCommandFor("remote")({
        commandId: "c",
        sessionId: "s",
        command: { kind: "session.stop" },
      }),
    ).rejects.toThrow();
    source.set(hostSnapshot([remoteHost(HOST, "box")], { other: HOST }));
    await expect(
      sessionCommandFor("remote")({
        commandId: "c",
        sessionId: "s",
        command: { kind: "session.stop" },
      }),
    ).rejects.toThrow("box isn’t connected");
    const closed = chatTransportFor("remote");
    await expect(closed.rpc.session.snapshot.query({ sessionId: "s" })).rejects.toThrow(
      "box isn’t connected",
    );
    expect(await sessionListingReaderForProject("remote").list({ projectId: "remote" })).toEqual({
      ok: false,
      error: "box isn’t connected",
    });
    bound.stop();
    // After the binding too: still the host's, still closed.
    await expect(
      chatTransportFor("other").rpc.session.projection.query({ sessionId: "s" }),
    ).rejects.toThrow("box isn’t connected");
  });

  it("re-homes resident chats as claims come and go and as bindings start and stop (B4)", () => {
    const first = bindRemoteSessions(deps());
    expect(rebinds).toEqual([["remote", "other"]]);
    source.set(hostSnapshot([remoteHost(HOST, "box")], { other: HOST }));
    expect(rebinds.at(-1)).toEqual(["remote"]);
    source.set(hostSnapshot([remoteHost(HOST, "box")], { remote: HOST, other: HOST }));
    expect(rebinds.at(-1)).toEqual(["remote"]);
    // A change that moves no claim re-homes nothing.
    const count = rebinds.length;
    source.setProjectLink("other", { status: "reconnecting" });
    expect(rebinds).toHaveLength(count);
    first.stop();
    expect(rebinds.at(-1)?.toSorted()).toEqual(["other", "remote"]);
    // Nothing claimed: a binding re-homes nothing at start.
    source.set(hostSnapshot([remoteHost(HOST, "box")], {}));
    const before = rebinds.length;
    bindRemoteSessions(deps()).stop();
    expect(rebinds).toHaveLength(before);
  });

  it("says an older host's Sessions are not available, once, and asks it nothing until its link changes (B3)", async () => {
    const options = deps();
    const bound = bindRemoteSessions(options);
    chatTransportFor("remote");
    const listing = workspaces.get("remote")!.listing;
    expect(sessionListingReaderForProject("remote")).toBe(listing);
    notGranted.get("remote")!();
    expect(availability.getState().unavailable).toEqual({
      remote: "Sessions aren’t available on box — update it to use them here",
    });
    // Its reads now answer at once, empty, without asking the host.
    expect(await sessionListingReaderForProject("remote").list({ projectId: "remote" })).toEqual({
      ok: true,
      sessions: [],
    });
    expect(
      await sessionListingReaderForTicket("remote-ticket").listForTicket({
        ticketId: "remote-ticket",
      }),
    ).toEqual({ ok: true, sessions: [] });
    expect(listing.list).not.toHaveBeenCalled();
    // Another project's link moving changes nothing for this one.
    source.setProjectLink("other", { status: "open" });
    expect(Object.keys(availability.getState().unavailable)).toEqual(["remote"]);
    // And no re-read is scheduled for it: focus and the poll read only the other.
    (options.window as unknown as EventTarget).dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(refreshed).toEqual(["other"]);
    // A new welcome (the link changed) may grant it: asked again, the state cleared.
    source.setProjectLink("remote", { status: "reconnecting" });
    expect(availability.getState().unavailable).toEqual({});
    source.setProjectLink("remote", { status: "open" });
    expect(refreshed).toContain("remote");
    expect(sessionListingReaderForProject("remote")).toBe(listing);
    // Refused again and then forgotten: the named state goes with the claim.
    notGranted.get("remote")!();
    source.set(hostSnapshot([remoteHost(HOST, "box")], { other: HOST }));
    expect(availability.getState().unavailable).toEqual({});
    // A late refusal for a project no longer claimed names nothing.
    notGranted.get("remote")!();
    expect(availability.getState().unavailable).toEqual({});
    // Refused and the binding stops: the state goes too.
    chatTransportFor("other");
    notGranted.get("other")!();
    bound.stop();
    expect(availability.getState().unavailable).toEqual({});
  });

  it("asks the current binding for a mounted chat's slot after cloud goes off and on (B4, N6)", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const experiments = {
      on: true,
      listeners: new Set<() => void>(),
      getState() {
        return { snapshot: { cloud: { enabled: this.on, source: "storage" as const } } };
      },
      subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
    const flip = (on: boolean) => {
      experiments.on = on;
      for (const listener of experiments.listeners) listener();
    };
    const stop = bindRemoteSessionsWhileCloud(experiments as never, () => deps());
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<View projectId="remote" />));
    const firstWorkspace = workspaces.get("remote")!;
    await act(async () => flip(false));
    expect(firstWorkspace.dispose).toHaveBeenCalled();
    await act(async () => flip(true));
    const secondWorkspace = workspaces.get("remote")!;
    expect(secondWorkspace).not.toBe(firstWorkspace);
    // The same mounted view, the same props: its slot asked of the new owner.
    expect(shown).toEqual(["s1", "-s1", "s1"]);
    await act(async () => root.unmount());
    expect(shown).toEqual(["s1", "-s1", "s1", "-s1"]);
    stop();
    vi.unstubAllGlobals();
  });

  it("binds while cloud is on, and unbinds when it turns off", () => {
    const experiments = {
      on: true,
      listeners: new Set<() => void>(),
      getState() {
        return { snapshot: { cloud: { enabled: this.on, source: "storage" as const } } };
      },
      subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
    const stop = bindRemoteSessionsWhileCloud(experiments as never, () => deps());
    expect(remoteSessions()).not.toBeNull();
    experiments.on = false;
    for (const listener of experiments.listeners) listener();
    expect(remoteSessions()).toBeNull();
    experiments.on = true;
    for (const listener of experiments.listeners) listener();
    const first = remoteSessions();
    // A change that leaves the flag on keeps the one binding.
    for (const listener of experiments.listeners) listener();
    expect(remoteSessions()).toBe(first);
    stop();
    expect(remoteSessions()).toBeNull();
    expect(experiments.listeners.size).toBe(0);
  });

  it("tells the bound Workspace a mounted view's Session is on screen, and nothing for This Mac", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const experiments = {
      getState: () => ({ snapshot: { cloud: { enabled: true, source: "storage" as const } } }),
      subscribe: () => () => {},
    };
    const stop = bindRemoteSessionsWhileCloud(experiments as never, () => deps());
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<View projectId="remote" />));
    await act(async () => root.render(<View projectId={null} />));
    await act(async () => root.unmount());
    expect(shown).toEqual(["s1", "-s1"]);
    stop();
    vi.unstubAllGlobals();
  });
});

describe("the window's own wiring (VC-713)", () => {
  afterEach(() => {
    useProjectsStore.setState({ selectedProjectId: null });
    useBoardStore.setState({ ticketsByProject: {} });
    useTicketSessionRecordsStore.setState({ byTicket: {} });
    vi.unstubAllGlobals();
  });

  it("reads the project on screen, a ticket's project and both listings from the window's stores", async () => {
    const deps = windowRemoteSessionsDeps();
    expect(deps.hosts).toBe(useHostConnectionStore);
    expect(deps.visibleProjects()).toEqual([]);
    useProjectsStore.setState({ selectedProjectId: "remote" });
    expect(deps.visibleProjects()).toEqual(["remote"]);
    useBoardStore.setState({
      ticketsByProject: { remote: [{ id: "t1" } as Ticket], local: [{ id: "t2" } as Ticket] },
    });
    const rebind = vi.spyOn(useChatSessionsStore.getState(), "rebindChatSessions");
    deps.rebindSessions(["remote"]);
    expect(rebind).toHaveBeenCalledWith(["remote"]);
    rebind.mockRestore();
    useTicketSessionRecordsStore.setState({ byTicket: { t1: [], t2: [] } });
    const projectRefresh = vi.spyOn(useProjectSessionsStore.getState(), "refresh");
    const ticketRefresh = vi.spyOn(useTicketSessionRecordsStore.getState(), "refresh");
    projectRefresh.mockResolvedValue();
    ticketRefresh.mockResolvedValue();
    await deps.refreshListings("remote");
    await deps.refreshListings("nowhere");
    expect(projectRefresh.mock.calls).toEqual([
      ["remote", { quiet: true }],
      ["nowhere", { quiet: true }],
    ]);
    expect(ticketRefresh.mock.calls).toEqual([["t1", { quiet: true }]]);
    const handle = deps.clock.setTimeout(() => {}, 1_000);
    deps.clock.clearTimeout(handle);
    expect(deps.clock.now()).toBeGreaterThan(0);
    projectRefresh.mockRestore();
    ticketRefresh.mockRestore();
  });

  it("builds a Workspace over main's relay, whose streams end with it", () => {
    vi.useFakeTimers();
    const workspace = relayedWorkspace({
      projectId: "remote",
      hostName: "hetzner-1",
      notGranted: () => {},
    });
    expect(workspace.projectId).toBe("remote");
    expect(workspace.transport.streamRecovery).toBe("host-link");
    const handlers = { onStarted: vi.fn(), onData: vi.fn(), onError: vi.fn(), onComplete: vi.fn() };
    // A stream the link has no slot for waits on a timer; disposing clears it.
    const limited = {
      subscribe: (_input: unknown, stream: { onError(error: unknown): void }) => {
        stream.onError({
          data: {
            hostError: { code: "TOO_MANY_REQUESTS", message: "full", reason: "subscription-limit" },
          },
        });
        return { unsubscribe: () => {} };
      },
    };
    workspace.streams.wrap(limited).subscribe({ sessionId: "s" }, handlers);
    workspace.streams.show("s");
    expect(handlers.onStarted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    workspace.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
