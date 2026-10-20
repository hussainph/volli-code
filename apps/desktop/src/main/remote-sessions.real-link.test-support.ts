/**
 * The real-link path's pieces for `remote-sessions.real-link.test.ts`
 * (VC-713), after `host-link-relay.real-link.test.ts` (VC-711): a scripted
 * executor for the box's Session runtime, a loopback route that can be cut,
 * main's link and relay behind the real IPC bridge, and a window's client of
 * that bridge. The test file owns `vi.mock("electron")` and passes the fake
 * `ipcMain`'s registrations in.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import {
  createHostLink,
  type HostLink,
  type HostLinkState,
} from "@volli/host-protocol/client-link";
import {
  ipcLink,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse,
} from "@volli/host-protocol/ipc";
import type {
  BindingHandle,
  HarnessCommand,
  NativeHarnessAdapter,
  ObservationSink,
} from "@volli/session-engine";
import type { DesktopIpcRouter } from "@volli/session-rpc";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type RuntimeObservation,
} from "@volli/shared";
import { createTRPCClient } from "@trpc/client";

import type { RelayLinkStateSource } from "../renderer/src/lib/relay-host-link";
import type { HostLinkView } from "../renderer/src/stores/host-connection";
import { createHostLinkRelay } from "./host-link-relay";

/** The remote project: its own Workspace on the box. */
export const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
export const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
export const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
export const CREDENTIAL = "remote-sessions-real-link-credential";

/** What a test tears down after it, last first. */
export type Cleanups = (() => unknown)[];

/** The fake `ipcMain`'s registrations, as the test file's `vi.mock("electron")` keeps them. */
export interface FakeIpcMain {
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
  readonly listeners: Map<string, (...args: unknown[]) => unknown>;
}

// ---- the box's executor --------------------------------------------------------

/**
 * The box's harness, scripted: it attaches, records every command the
 * runtime dispatches to it and accepts it, and says only what the test makes
 * it say (`emit`, `turn`).
 */
export class ScriptedExecutor implements NativeHarnessAdapter {
  readonly id = "scripted";
  readonly durableIdNamespace = "scripted";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/box/scripted", version: "1.0.0", fingerprint: "sha256:scripted" };
  attaches = 0;
  readonly commands: HarnessCommand[] = [];
  #sink: ObservationSink | null = null;

  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.attaches += 1;
    this.#sink = sink;
    return {
      native: { id: `scripted-native-${this.attaches}`, detail: null },
      dispatch: async (command) => {
        this.commands.push(command);
        return {
          commandId: command.commandId,
          status: "accepted" as const,
          acceptedAt: Date.now(),
          native: { id: command.commandId, detail: null },
        };
      },
      reconcile: async () => ({ cursor: { value: 0 }, observations: [], receipts: [] }),
      acknowledgeReconciliation: async () => {},
      release: async () => {},
    };
  }

  commandKinds(): string[] {
    return this.commands.map(({ kind }) => kind);
  }

  emit(observation: RuntimeObservation): Promise<void> {
    if (this.#sink === null) throw new Error("The scripted executor is not attached");
    return this.#sink.emit(observation);
  }

  /** One whole turn that says `text`: started, streamed, settled, completed. */
  async turn(turnId: string, text: string): Promise<void> {
    await this.emit({ kind: "turn", state: "started", turnId, occurredAt: Date.now() });
    await this.emit({ kind: "delta", turnId, channel: "text", text });
    await this.emit({
      kind: "message-settled",
      turnId,
      occurredAt: Date.now(),
      message: { entryId: `${turnId}:reply`, role: "assistant", text },
    });
    await this.emit({ kind: "turn", state: "completed", turnId, occurredAt: Date.now() });
  }
}

// ---- the tunnel ----------------------------------------------------------------

/** A loopback TCP route in front of the box that a test can cut and block (the tunnel). */
export async function cuttableRoute(target: string, cleanups: Cleanups) {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  let blocked = false;
  const server: Server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(port), hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cut(): void {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    unblock(): void {
      blocked = false;
    },
  };
}

// ---- desktop main --------------------------------------------------------------

export function workspaceLink(
  url: string,
  features: readonly string[],
  cleanups: Cleanups,
): HostLink {
  const link = createHostLink({
    url,
    workspaceId: PROJECT,
    client: { kind: "desktop", version: "remote-sessions-real-link" },
    features: features as never,
    credential: () => CREDENTIAL,
    timing: { backoffBaseMs: 20, backoffCapMs: 40 },
  });
  cleanups.push(() => link.close());
  return link;
}

export function untilState(link: HostLink, status: HostLinkState["status"]): Promise<void> {
  if (link.getState().status === status) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`never ${status}: ${link.getState().status}`)),
      5_000,
    );
    const stop = link.subscribeState((state) => {
      if (state.status !== status) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** Main: the relay over the engine's one link, in the desktop's own map, behind the real bridge. */
export async function desktopMain(link: HostLink, electron: FakeIpcMain, cleanups: Cleanups) {
  const relay = createHostLinkRelay({
    workspaceLink: (workspaceId) =>
      workspaceId === PROJECT && link.getState().status === "ready" ? link : null,
    serves: (workspaceId) => workspaceId === PROJECT,
  });
  const map = createHostHandlers(
    { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
    {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      hostLinkRelay: relay,
    },
  );
  const { registerSessionRpcIpcHandlers } = await import("./session-rpc-ipc");
  const registration = registerSessionRpcIpcHandlers({
    handlers: admittedHandlers(map, ROUTER_POLICY),
  });
  cleanups.push(() => registration.close());
  return {
    relay,
    invoke: electron.handlers.get(SESSION_RPC_IPC_CHANNEL)!,
    cancel: electron.listeners.get(SESSION_RPC_CANCEL_CHANNEL)!,
  };
}

// ---- the window ----------------------------------------------------------------

let senders = 1;

/**
 * A window: its WebContents as main sees it, and the bridge's real client link
 * over it. Every request it sends main is kept, in order (`requests`).
 */
export function window(main: Awaited<ReturnType<typeof desktopMain>>) {
  const requests: IpcRequest[] = [];
  const pushes = new Set<(event: IpcEvent) => void>();
  const gone = new Set<() => void>();
  let destroyed = false;
  const sender = {
    id: senders++,
    isDestroyed: () => destroyed,
    send: (channel: string, event: IpcEvent) => {
      if (channel !== SESSION_RPC_EVENT_CHANNEL) throw new Error(`unexpected channel ${channel}`);
      const copy = structuredClone(event);
      queueMicrotask(() => {
        for (const push of pushes) push(copy);
      });
    },
    once: (_event: string, listener: () => void) => void gone.add(listener),
    on: () => {},
    removeListener: (_event: string, listener: () => void) => void gone.delete(listener),
  };
  const client = createTRPCClient<DesktopIpcRouter>({
    links: [
      ipcLink<DesktopIpcRouter>({
        request: async (request) => {
          requests.push(structuredClone(request));
          return structuredClone(
            (await main.invoke({ sender }, structuredClone(request))) as IpcResponse,
          );
        },
        onEvent: (listener) => {
          pushes.add(listener);
          return () => void pushes.delete(listener);
        },
        cancel: (subscriptionId) => void main.cancel({ sender }, subscriptionId),
      }),
    ],
  });
  return {
    client,
    requests,
    /** The window goes: its WebContents is destroyed. */
    close(): void {
      destroyed = true;
      for (const listener of Array.from(gone)) listener();
      pushes.clear();
    },
  };
}

/** The project's link as the window's host-connection store reads it (main's snapshot, mapped). */
const viewOf = (state: HostLinkState): HostLinkView =>
  state.status === "ready" ? { status: "open" } : { status: "reconnecting" };

export function storeState(link: HostLink): RelayLinkStateSource {
  let current = viewOf(link.getState());
  return {
    getState: () => current,
    subscribe: (listener) =>
      link.subscribeState((state) => {
        current = viewOf(state);
        listener();
      }),
  };
}

/** How many times the window asked main's relay for `path` on the project's link. */
export function relayAsks(requests: readonly IpcRequest[], path: string): number {
  return requests.filter(
    (request) =>
      request.path.startsWith("hostLink.") &&
      (request.input as { workspaceId?: unknown; path?: unknown } | null)?.workspaceId ===
        PROJECT &&
      (request.input as { path?: unknown }).path === path,
  ).length;
}

/**
 * A clock the test moves by hand: the binding's re-read schedule and a
 * Workspace's stream retries run on it, so a minute of polls takes no real
 * minute and every timer they leave is counted (`pending`).
 */
export function manualClock() {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run: () => void, ms: number): unknown {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    /** Timers set and neither fired nor cleared. */
    pending: (): number => timers.size,
    /** Moves time on by `ms`, running each timer due on the way, oldest first. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; run: () => void }] | null = null;
        for (const entry of timers)
          if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

/**
 * The window as the binding reads it: its focus and visibility events, which
 * a test dispatches (`focus()`), and a document that stays visible.
 */
export function bindingWindow() {
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  return {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    document: {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
    focus(): void {
      events.dispatchEvent(new Event("focus"));
    },
  };
}

/**
 * This Mac's own IPC as the renderer reaches it (`window.api`), recording
 * every call and serving none: a remote project's Session must never reach
 * it. Also the frame and timer host the chat transports pace their flushes on.
 */
export function thisMacWindow() {
  const calls: string[] = [];
  const refuse = (door: string) => {
    calls.push(door);
    return Promise.reject(new Error(`This Mac's IPC was asked: ${door}`));
  };
  return {
    calls,
    window: {
      api: {
        sessionRpc: {
          request: (request: IpcRequest) => refuse(`sessionRpc ${request.path}`),
          onEvent: () => () => {},
          cancel: (subscriptionId: string) =>
            void calls.push(`sessionRpc.cancel ${subscriptionId}`),
        },
        sessions: {
          list: () => refuse("sessions.list"),
          listForTicket: () => refuse("sessions.listForTicket"),
        },
      },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}
