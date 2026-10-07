// @vitest-environment node
/** The warning reads through the production relay and a real loopback host link. */
// The desktop owns jsdom, but does not ship its ambient types.
// @ts-expect-error — only the typed-at-runtime JSDOM constructor is used.
import { JSDOM } from "jsdom";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createHostLink, type HostLink } from "@volli/host-protocol/client-link";
import { createHostRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type SessionListingPage,
  type SessionListingRow,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as remote from "@renderer/lib/remote-session-wire";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { registryHost } from "@renderer/stores/remote-hosts.test-support";

import { useRestartSessionCount } from "./use-restart-session-count";

// Only desktop IPC is replaced: every query is forwarded to createHostLink,
// and the renderer's relayHostLink and Session tRPC client remain production.
const ipc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({ hostLink: { query: { query: ipc.query } } }),
}));

const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_PROJECT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const HOST = registryHost();
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const WAIT = { timeout: 5_000, interval: 10 };
const cleanups: (() => unknown)[] = [];
const links = new Map<string, HostLink>();
const reads: { signal: AbortSignal | null | undefined; settled: boolean }[] = [];

beforeEach(() => {
  // Preserve Node's Event/AbortSignal realm for its real WebSocket implementation.
  const dom = new JSDOM("<body></body>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  const hostsBefore = useRemoteHostsStore.getState();
  const connectionsBefore = useHostConnectionStore.getState();
  cleanups.push(() => {
    useRemoteHostsStore.setState(hostsBefore, true);
    useHostConnectionStore.setState(connectionsBefore, true);
  });
  useRemoteHostsStore.setState({ hosts: [HOST] });
  useHostConnectionStore.setState({
    hosts: [
      {
        id: HOST.id,
        name: HOST.name,
        local: false,
        os: HOST.os,
        version: HOST.version,
        link: { status: "open" },
        liveSessions: null,
        update: null,
        expiredSignIns: [],
      },
    ],
    projects: {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ipc.query.mockImplementation(({ workspaceId, path, input }) => {
    const link = links.get(workspaceId);
    if (link === undefined) throw new Error(`No real link for ${workspaceId}`);
    return link.query(path, input);
  });
  // Observe the hook's AbortSignal without replacing its client or its transport.
  const original = remote.remoteSessionClient;
  vi.spyOn(remote, "remoteSessionClient").mockImplementation((...args) => {
    const client = original(...args);
    const query: typeof client.session.listing.query = (input, options) => {
      const read = { signal: options?.signal, settled: false };
      reads.push(read);
      const result = client.session.listing.query(input, options);
      void result.then(
        () => {
          read.settled = true;
        },
        () => {
          read.settled = true;
        },
      );
      return result;
    };
    return new Proxy(client, {
      get(target, key) {
        if (key !== "session") return Reflect.get(target, key);
        return new Proxy(client.session, {
          get(session, name) {
            return name === "listing" ? { query } : Reflect.get(session, name);
          },
        });
      },
    });
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  links.clear();
  reads.length = 0;
  ipc.query.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chat(sessionId: string, live = true, projectId = PROJECT): SessionListingRow {
  return {
    kind: "chat",
    record: {
      sessionId,
      projectId,
      title: "Chat",
      ticketId: null,
      createdAt: 1,
      adapterId: "pi",
      live,
      activity: live ? "working" : "idle",
      waitingOn: null,
      outcome: null,
      lastActivityAt: 2,
      bornTicketless: true,
      role: "project",
      parentSessionId: null,
      model: null,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

function terminal(id: string, endedAt: number | null = null): SessionListingRow {
  return {
    kind: "terminal",
    record: {
      id,
      projectId: PROJECT,
      ticketId: null,
      title: "Terminal",
      harnessId: "claude-code",
      activeHarnessId: null,
      harnessSessionId: null,
      launchKind: "agent",
      placement: "tab",
      cwd: "/fixture",
      createdAt: 1,
      endedAt,
      exitCode: endedAt === null ? null : 0,
      lastActivityAt: 2,
      bornTicketless: true,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

const page = (...sessions: SessionListingRow[]): SessionListingPage => ({ sessions, omitted: 0 });

function heldPage() {
  let release!: (value: SessionListingPage) => void;
  const promise = new Promise<SessionListingPage>((resolve) => {
    release = resolve;
  });
  // Pending fixture work must not outlive the listener's teardown.
  cleanups.push(() => release(page()));
  return { promise, release };
}

/** Production listener, with only its listing handler scripted; no machine keys. */
async function host(read: (projectId: string) => SessionListingPage | Promise<SessionListingPage>) {
  const calls: string[] = [];
  const completed: string[] = [];
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST.id, version: "restart-count-test" },
    features: ["sessions.listing"],
    // The warning's one-minute no-poll test must not race a socket heartbeat.
    limits: { pingMs: 120_000 },
    workspace: (id) => ([PROJECT, OTHER_PROJECT].includes(id) ? { id, epoch: 1 } : null),
    verifier: {
      verify: ({ workspaceId }) => ({
        actor: { kind: "device", deviceId: DEVICE, workspaceId },
        current: () => true,
      }),
    },
    context: () => ({
      diagnostics: new RpcDiagnosticLog(),
      handlers: {
        "session.listing": async ({ projectId }: { projectId: string }) => {
          calls.push(projectId);
          const answer = await read(projectId);
          completed.push(projectId);
          return answer;
        },
      } as never,
    }),
  });
  cleanups.push(() => listener.close());

  // A cuttable TCP route gives a real connection loss, not a fabricated state.
  const sockets = new Set<Socket>();
  let blocked = false;
  const route = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(listener.address.port, listener.address.host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => route.close(resolve)));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });

  async function open(projectId = PROJECT) {
    const link = createHostLink({
      url: `ws://127.0.0.1:${(route.address() as AddressInfo).port}`,
      workspaceId: projectId,
      client: { kind: "desktop", version: "restart-count-test" },
      features: ["sessions.listing"],
      credential: () => "fixture-only-credential",
      timing: { backoffBaseMs: 20, backoffCapMs: 40, heartbeatIntervalMs: 120_000 },
    });
    links.set(projectId, link);
    cleanups.push(() => link.close());
    const publish = () => {
      const state = link.getState();
      useHostConnectionStore.setState(({ projects }) => ({
        projects: {
          ...projects,
          [projectId]: {
            hostId: HOST.id,
            link: state.status === "ready" ? { status: "open" } : { status: "reconnecting" },
            granted: state.status === "ready" ? state.welcome.features : [],
          },
        },
      }));
    };
    cleanups.push(link.subscribeState(publish));
    publish();
    await vi.waitFor(() => expect(link.getState().status).toBe("ready"), WAIT);
    return link;
  }
  return {
    calls,
    completed,
    open,
    cut() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    unblock() {
      blocked = false;
    },
  };
}

async function view(questionId: string | null = "question-1", target = HOST.target) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rendered: (number | null)[] = [];
  let mounted = true;
  function Probe(props: { questionId: string | null; target: string }) {
    const count = useRestartSessionCount(props.questionId, props.target);
    rendered.push(count);
    return <output>{count === null ? "unknown" : count}</output>;
  }
  const rerender = async (nextQuestion = questionId, nextTarget = target) => {
    questionId = nextQuestion;
    target = nextTarget;
    await act(async () => root.render(<Probe questionId={questionId} target={target} />));
  };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  await rerender();
  return { rerender, unmount, rendered, count: () => container.textContent };
}

async function flush() {
  // Give the actual socket and tRPC callbacks a turn while React owns updates.
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await pause(30);
  });
}

async function expectCount(probe: Awaited<ReturnType<typeof view>>, value: string) {
  await vi.waitFor(async () => {
    await flush();
    expect(probe.count()).toBe(value);
  }, WAIT);
}

describe("restart warning's bounded live Session count", () => {
  it.each([
    "no question",
    "unknown host",
    "host health missing",
    "no open projects",
    "link not ready",
    "feature absent",
    "other host",
  ])("does not guess or read for %s", async (reason) => {
    const box = await host(() => page(chat("live")));
    const link = await box.open();
    if (reason === "unknown host") useRemoteHostsStore.setState({ hosts: [] });
    if (reason === "host health missing") useHostConnectionStore.setState({ hosts: [] });
    if (reason === "no open projects") useHostConnectionStore.setState({ projects: {} });
    if (reason === "link not ready") link.close();
    if (reason === "feature absent" || reason === "other host") {
      const project = useHostConnectionStore.getState().projects[PROJECT]!;
      useHostConnectionStore.setState({
        projects: {
          [PROJECT]: {
            ...project,
            ...(reason === "feature absent" ? { granted: [] } : { hostId: "another-host" }),
          },
        },
      });
    }
    const probe = await view(reason === "no question" ? null : "question-1");
    await flush();
    expect(probe.count()).toBe("unknown");
    expect(ipc.query).not.toHaveBeenCalled();
    expect(box.calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("counts live chat and live terminals, not stopped rows, and reads only once per question (no polling)", async () => {
    const box = await host(() =>
      page(chat("chat"), chat("stopped", false), terminal("terminal"), terminal("ended", 3)),
    );
    await box.open();
    vi.useFakeTimers();
    const probe = await view();
    await expectCount(probe, "2");
    expect(box.calls).toEqual([PROJECT]);
    expect(ipc.query.mock.calls[0]?.[0]).toEqual({
      workspaceId: PROJECT,
      path: "session.listing",
      input: { projectId: PROJECT },
    });
    expect(reads[0]?.signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await probe.rerender();
    window.dispatchEvent(new window.Event("focus"));
    expect(ipc.query).toHaveBeenCalledTimes(1);
    expect(probe.count()).toBe("2");
    vi.useRealTimers();
    await probe.rerender("question-2");
    await expectCount(probe, "2");
    expect(box.calls).toEqual([PROJECT, PROJECT]);
  });

  it("aggregates all open projects on the host and deduplicates Session identities", async () => {
    const box = await host((projectId) =>
      projectId === PROJECT
        ? page(chat("shared"), terminal("terminal"))
        : page(chat("shared", true, OTHER_PROJECT), chat("second", true, OTHER_PROJECT)),
    );
    await box.open();
    await box.open(OTHER_PROJECT);
    const probe = await view();
    await expectCount(probe, "3");
    expect(box.calls.toSorted()).toEqual([PROJECT, OTHER_PROJECT].toSorted());
    expect(reads).toHaveLength(2);
    expect(reads[0]?.signal).toBe(reads[1]?.signal);
  });

  it("reports an exact zero for a complete listing with no live Sessions", async () => {
    const box = await host(() => page(chat("stopped", false), terminal("ended", 3)));
    await box.open();
    await expectCount(await view(), "0");
  });

  it.each(["omitted", "error"])(
    "keeps the count unknown when any project's listing has %s",
    async (failure) => {
      const box = await host((projectId) => {
        if (projectId === PROJECT) return page(chat("live"));
        if (failure === "error") throw new Error("Fixture listing unavailable");
        return { ...page(chat("partial", true, OTHER_PROJECT)), omitted: 1 };
      });
      await box.open();
      await box.open(OTHER_PROJECT);
      const probe = await view();
      await vi.waitFor(() => expect(reads.every((read) => read.settled)).toBe(true), WAIT);
      await flush();
      expect(probe.count()).toBe("unknown");
      expect(box.calls).toHaveLength(2);
      expect(probe.rendered).not.toContain(1);
    },
  );

  it("aborts a pending sibling when another real project listing rejects", async () => {
    const delayed = heldPage();
    const box = await host((projectId) => {
      if (projectId === PROJECT) throw new Error("Fixture listing refused");
      return delayed.promise;
    });
    await box.open();
    await box.open(OTHER_PROJECT);
    const probe = await view();
    await act(async () => {
      await vi.waitFor(() => expect(box.calls).toHaveLength(2), WAIT);
      await pause(2_100);
    });
    expect(reads).toHaveLength(2);
    expect(reads.every((read) => read.settled || read.signal?.aborted)).toBe(true);
    expect(reads.every((read) => read.signal?.aborted)).toBe(true);
    expect(probe.count()).toBe("unknown");
    delayed.release(page(chat("late-sibling", true, OTHER_PROJECT)));
    await flush();
    expect(probe.count()).toBe("unknown");
    expect(probe.rendered).not.toContain(1);
    expect(box.calls).toHaveLength(2);
  });

  it("aborts a delayed read at two seconds and ignores the host's later answer", async () => {
    const delayed = heldPage();
    const box = await host(() => delayed.promise);
    await box.open();
    vi.useFakeTimers();
    const probe = await view();
    // tRPC batches socket writes on a zero-delay timer. Flush that, not the bound.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let tries = 0; box.calls.length === 0 && tries < 100; tries++) await pause(5);
    });
    expect(box.calls).toEqual([PROJECT]);
    const signal = reads[0]?.signal;
    expect(signal).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(signal?.aborted).toBe(true);
    expect(reads[0]?.settled).toBe(true);
    vi.useRealTimers();
    delayed.release(page(chat("late")));
    await flush();
    expect(box.completed).toEqual([PROJECT]);
    expect(probe.count()).toBe("unknown");
    expect(probe.rendered).not.toContain(1);
    expect(box.calls).toHaveLength(1);
  });

  it("aborts on real link loss and does not re-read after reconnecting", async () => {
    const delayed = heldPage();
    const box = await host(() => delayed.promise);
    const link = await box.open();
    const probe = await view();
    await vi.waitFor(() => expect(box.calls).toHaveLength(1), WAIT);
    await act(async () => {
      box.cut();
      await vi.waitFor(() => expect(link.getState().status).not.toBe("ready"), WAIT);
    });
    expect(reads[0]?.signal?.aborted).toBe(true);
    delayed.release(page(chat("late")));
    await act(async () => {
      box.unblock();
      await vi.waitFor(() => expect(link.getState().status).toBe("ready"), WAIT);
    });
    await flush();
    expect(probe.count()).toBe("unknown");
    expect(box.calls).toHaveLength(1);
    expect(ipc.query).toHaveBeenCalledTimes(1);
  });

  it("clears an already displayed count when its real link goes away", async () => {
    const box = await host(() => page(chat("live")));
    const link = await box.open();
    const probe = await view();
    await expectCount(probe, "1");
    await act(async () => {
      box.cut();
      await vi.waitFor(() => expect(link.getState().status).not.toBe("ready"), WAIT);
    });
    expect(probe.count()).toBe("unknown");
    expect(reads[0]?.signal?.aborted).toBe(true);
  });

  it.each([
    "project removed",
    "project reassigned",
    "host health removed",
    "registry host removed",
    "target changed",
    "listing grant removed",
  ])("invalidates a displayed or pending count when %s", async (change) => {
    for (const pending of [false, true]) {
      const delayed = heldPage();
      const box = await host(() => (pending ? delayed.promise : page(chat("live"))));
      await box.open();
      const probe = await view();
      await act(async () => {
        await vi.waitFor(() => expect(box.calls).toHaveLength(1), WAIT);
      });
      if (!pending) await expectCount(probe, "1");
      await act(async () => {
        const state = useHostConnectionStore.getState();
        if (change === "project removed") useHostConnectionStore.setState({ projects: {} });
        if (change === "project reassigned")
          useHostConnectionStore.setState({
            projects: { [PROJECT]: { ...state.projects[PROJECT]!, hostId: "another-host" } },
          });
        if (change === "host health removed") useHostConnectionStore.setState({ hosts: [] });
        if (change === "registry host removed") useRemoteHostsStore.setState({ hosts: [] });
        if (change === "target changed")
          useRemoteHostsStore.setState({ hosts: [{ ...HOST, target: "another@target" }] });
        if (change === "listing grant removed")
          useHostConnectionStore.setState({
            projects: { [PROJECT]: { ...state.projects[PROJECT]!, granted: undefined } },
          });
      });
      expect(reads.at(-1)?.signal?.aborted).toBe(true);
      expect(probe.count()).toBe("unknown");
      delayed.release(page(chat("late")));
      await flush();
      expect(probe.count()).toBe("unknown");
      expect(box.calls).toHaveLength(1);
      await probe.unmount();
      // Restore the stores before exercising the pending-read half.
      useRemoteHostsStore.setState({ hosts: [HOST] });
      useHostConnectionStore.setState({
        hosts: [
          {
            id: HOST.id,
            name: HOST.name,
            local: false,
            os: HOST.os,
            version: HOST.version,
            link: { status: "open" },
            liveSessions: null,
            update: null,
            expiredSignIns: [],
          },
        ],
        projects: {},
      });
    }
  });

  it("aborts on unmount, removes its state listener, and never renders a late response", async () => {
    const delayed = heldPage();
    const box = await host(() => delayed.promise);
    await box.open();
    const originalSubscribe = useHostConnectionStore.subscribe;
    const stopped = vi.fn();
    let queuedStateChange: (() => void) | null = null;
    const subscribe = vi
      .spyOn(useHostConnectionStore, "subscribe")
      .mockImplementation((listener) => {
        queuedStateChange = () =>
          listener(useHostConnectionStore.getState(), useHostConnectionStore.getState());
        const stop = originalSubscribe(listener);
        return () => {
          stopped();
          stop();
        };
      });
    const probe = await view();
    await vi.waitFor(() => expect(box.calls).toHaveLength(1), WAIT);
    const signal = reads[0]?.signal;
    const rendered = [...probe.rendered];
    await probe.unmount();
    expect(signal?.aborted).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    delayed.release(page(chat("late")));
    await flush();
    expect(probe.rendered).toEqual(rendered);
    // State changes after cleanup cannot re-read or revive the old warning.
    await act(async () => box.cut());
    await flush();
    // A callback captured before unsubscribe may already be queued in a transport.
    // Read the actual cut link's state, but deliver that stale callback after cleanup.
    await act(async () => queuedStateChange?.());
    expect(probe.rendered).toEqual(rendered);
    expect(ipc.query).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let a previous question's late answer replace the new question's count", async () => {
    const delayed = heldPage();
    let calls = 0;
    const box = await host(() =>
      ++calls === 1 ? delayed.promise : page(chat("new-1"), chat("new-2")),
    );
    await box.open();
    const probe = await view();
    await vi.waitFor(() => expect(box.calls).toHaveLength(1), WAIT);
    await probe.rerender("question-2");
    expect(reads[0]?.signal?.aborted).toBe(true);
    await expectCount(probe, "2");
    delayed.release(page(chat("old")));
    await flush();
    expect(box.completed).toHaveLength(2);
    expect(probe.count()).toBe("2");
    expect(probe.rendered).not.toContain(1);
    await probe.rerender(null);
    expect(probe.count()).toBe("unknown");
    expect(reads[1]?.signal?.aborted).toBe(true);
    expect(ipc.query).toHaveBeenCalledTimes(2);
  });
});
