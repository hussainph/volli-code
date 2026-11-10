import { deserialize, serialize } from "node:v8";
import type { WebContents } from "electron";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AppStateSetResult,
  SettingsWindowIpcChannel,
  SettingsWindowNavigation,
  WorkspaceWindowNavigation,
} from "../ipc/contract";
import type { Api } from "../preload";
import type { SettingsWindowIpcPorts } from "./settings-window-ipc";

const { handlers, listeners, rendererSender, sent } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: WebContents }, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  rendererSender: { id: 42 } as WebContents,
  sent: [] as { target: number; channel: string; payload: unknown }[],
}));

/** Electron's wire is structured-cloned; exercise a real V8 codec, not shared references. */
function wire<T>(value: T): T {
  return deserialize(serialize(value)) as T;
}

vi.mock("electron", () => ({
  ipcMain: {
    handle(
      channel: string,
      handler: (event: { sender: WebContents }, ...args: unknown[]) => unknown,
    ) {
      handlers.set(channel, handler);
    },
  },
  ipcRenderer: {
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return wire(await handler({ sender: rendererSender }, ...wire(args)));
    },
    on(channel: string, listener: (event: unknown, payload: unknown) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    },
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void) {
      listeners.get(channel)?.delete(listener);
    },
  },
  contextBridge: {},
  webUtils: {},
}));

import { SETTINGS_WINDOW_IPC } from "./ipc-descriptors";
import {
  registerSettingsWindowIpcHandlers,
  sendSettingsWindowNavigation,
  sendWorkspaceWindowNavigation,
} from "./settings-window-ipc";

const NAVIGATION: SettingsWindowNavigation = {
  revision: 1,
  category: "connections",
  configureCategory: "model-access",
  signInProviderId: "provider-id",
  projectId: "project-id",
  workspaceId: "workspace-id",
};

const WORKSPACE_NAVIGATIONS: WorkspaceWindowNavigation[] = [
  {
    kind: "file",
    projectId: "project-id",
    relPath: ".volli/settings.json",
    workspaceId: "workspace-id",
  },
  { kind: "ticket", projectId: "project-id", ticketId: "ticket-id", workspaceId: "workspace-id" },
  { kind: "file", projectId: "local-project", relPath: ".volli/settings.json" },
  { kind: "ticket", projectId: "local-project", ticketId: "local-ticket" },
];

function register(overrides: Partial<SettingsWindowIpcPorts> = {}) {
  const ports: SettingsWindowIpcPorts = {
    open: vi.fn(),
    pendingNavigation: vi.fn(() => NAVIGATION),
    ready: vi.fn(() => NAVIGATION),
    openWorkspace: vi.fn(),
    pendingWorkspaceNavigation: vi.fn(() => WORKSPACE_NAVIGATIONS[0]!),
    ...overrides,
  };
  registerSettingsWindowIpcHandlers(ports);
  return ports;
}

async function invoke(channel: SettingsWindowIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return wire(await handler({ sender: rendererSender }, ...wire(args)));
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  sent.length = 0;
});

describe("Settings window guarded desktop transport", () => {
  it("registers every channel through the real shared registry", () => {
    register();
    expect([...handlers.keys()].toSorted()).toEqual(Object.keys(SETTINGS_WINDOW_IPC).toSorted());
  });

  it.each([{}, NAVIGATION, { projectId: null }])(
    "forwards the presentation intent and invoking WebContents, not a copied sender",
    async (input) => {
      const ports = register();
      await expect(invoke("volli:settings-window-open", input)).resolves.toEqual({ ok: true });
      expect(ports.open).toHaveBeenCalledWith(input, rendererSender);
      const received = vi.mocked(ports.open).mock.calls[0]![0];
      expect(received).not.toBe(input);
      expect(ports.pendingNavigation).not.toHaveBeenCalled();
      expect(ports.ready).not.toHaveBeenCalled();
    },
  );

  it.each([
    [],
    [undefined],
    [null],
    [[]],
    ["connections"],
    [{ category: null }],
    [{ category: 5 }],
    [{ configureCategory: false }],
    [{ signInProviderId: {} }],
    [{ projectId: 7 }],
    [{ workspaceId: "" }],
    [{ workspaceId: null }],
    [{ workspaceId: 7 }],
    [{ workspaceId: {} }],
    [{}, {}],
  ])("refuses malformed open arguments before calling the window port: %j", async (...args) => {
    const ports = register();
    await expect(invoke("volli:settings-window-open", ...args)).resolves.toEqual({
      ok: false,
      error: "Invalid Settings window request",
    });
    expect(ports.open).not.toHaveBeenCalled();
  });

  it("reads pending intent without marking the renderer ready", async () => {
    const ports = register();
    await expect(invoke("volli:settings-window-pending-navigation")).resolves.toEqual({
      ok: true,
      navigation: NAVIGATION,
    });
    expect(ports.pendingNavigation).toHaveBeenCalledWith(rendererSender);
    expect(ports.ready).not.toHaveBeenCalled();
  });

  it("preserves the same revision across pending and ready so an intent is consumed once", async () => {
    register();
    const pending = await invoke("volli:settings-window-pending-navigation");
    const ready = await invoke("volli:settings-window-ready", NAVIGATION.revision);
    expect(pending).toEqual({ ok: true, navigation: NAVIGATION });
    expect(ready).toEqual(pending);
    expect(ready).not.toBe(pending);
  });

  it("acknowledges a committed renderer independently and returns the latest boot intent", async () => {
    const latest = { category: "appearance", projectId: null, revision: 2 };
    const ports = register({ ready: vi.fn(() => latest) });
    await invoke("volli:settings-window-pending-navigation");
    await expect(invoke("volli:settings-window-ready", NAVIGATION.revision)).resolves.toEqual({
      ok: true,
      navigation: latest,
    });
    expect(ports.ready).toHaveBeenCalledWith(NAVIGATION.revision, rendererSender);
    await invoke("volli:settings-window-ready", latest.revision);
    expect(ports.ready).toHaveBeenLastCalledWith(latest.revision, rendererSender);
  });

  it.each(["volli:settings-window-pending-navigation", "volli:settings-window-ready"] as const)(
    "preserves no navigation and rejects extra payloads on %s",
    async (channel) => {
      const ports = register({ pendingNavigation: vi.fn(() => null), ready: vi.fn(() => null) });
      const args = channel.endsWith("ready") ? [0] : [];
      await expect(invoke(channel, ...args)).resolves.toEqual({ ok: true, navigation: null });
      const method = channel.endsWith("ready") ? ports.ready : ports.pendingNavigation;
      expect(method).toHaveBeenCalledTimes(1);
      await expect(invoke(channel, {})).resolves.toMatchObject({ ok: false });
      expect(method).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [],
    [undefined],
    [null],
    ["1"],
    [true],
    [{}],
    [[]],
    [-1],
    [0.5],
    [NaN],
    [Infinity],
    [0, 1],
  ])("refuses malformed painted revisions before calling ready: %j", async (...args) => {
    const ports = register();
    await expect(invoke("volli:settings-window-ready", ...args)).resolves.toEqual({
      ok: false,
      error: "Invalid Settings readiness request",
    });
    expect(ports.ready).not.toHaveBeenCalled();
  });

  it("returns synchronous native failures as data", async () => {
    register({
      open: () => {
        throw new Error("Native Settings unavailable");
      },
    });
    await expect(invoke("volli:settings-window-open", {})).resolves.toEqual({
      ok: false,
      error: "Native Settings unavailable",
    });
  });

  it("returns rejected native opens as data", async () => {
    register({
      open: async () => {
        throw new Error("Settings load failed");
      },
    });
    await expect(invoke("volli:settings-window-open", {})).resolves.toEqual({
      ok: false,
      error: "Settings load failed",
    });
  });

  it.each(["volli:settings-window-pending-navigation", "volli:settings-window-ready"] as const)(
    "surfaces an unauthorized requester or readiness failure on %s",
    async (channel) => {
      const message = `Not the Settings renderer: ${channel}`;
      const refused = () => {
        throw new Error(message);
      };
      register({ pendingNavigation: refused, ready: refused });
      const args = channel.endsWith("ready") ? [NAVIGATION.revision] : [];
      await expect(invoke(channel, ...args)).resolves.toEqual({
        ok: false,
        error: message,
      });
    },
  );

  it.each(WORKSPACE_NAVIGATIONS)(
    "forwards a workspace reveal and the invoking renderer: $kind",
    async (input) => {
      const ports = register();
      await expect(invoke("volli:settings-window-open-workspace", input)).resolves.toEqual({
        ok: true,
      });
      expect(ports.openWorkspace).toHaveBeenCalledWith(input, rendererSender);
      expect(vi.mocked(ports.openWorkspace).mock.calls[0]![0]).not.toBe(input);
      expect(ports.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    [],
    [undefined],
    [null],
    [[]],
    [{}],
    [{ kind: "file", relPath: "settings.json" }],
    [{ kind: "file", projectId: "project-id" }],
    [{ kind: "file", projectId: "project-id", relPath: null }],
    [{ kind: "ticket", projectId: "project-id" }],
    [{ kind: "ticket", projectId: "project-id", ticketId: 7 }],
    [{ kind: "unknown", projectId: "project-id", relPath: "settings.json" }],
    [{ kind: "file", projectId: null, relPath: "settings.json" }],
    [{ kind: "file", projectId: "project-id", relPath: "settings.json", workspaceId: "" }],
    [{ kind: "file", projectId: "project-id", relPath: "settings.json", workspaceId: null }],
    [{ kind: "ticket", projectId: "project-id", ticketId: "ticket-id", workspaceId: "" }],
    [{ kind: "ticket", projectId: "project-id", ticketId: "ticket-id", workspaceId: 7 }],
    [{ kind: "ticket", projectId: "project-id", ticketId: "ticket-id" }, {}],
  ])("rejects malformed workspace reveal arguments: %j", async (...args) => {
    const ports = register();
    await expect(invoke("volli:settings-window-open-workspace", ...args)).resolves.toEqual({
      ok: false,
      error: "Invalid workspace navigation request",
    });
    expect(ports.openWorkspace).not.toHaveBeenCalled();
  });

  it.each([...WORKSPACE_NAVIGATIONS, null])(
    "recovers a parked workspace reveal using the requesting renderer",
    async (navigation) => {
      const ports = register({ pendingWorkspaceNavigation: vi.fn(() => navigation) });
      await expect(invoke("volli:settings-window-pending-workspace-navigation")).resolves.toEqual({
        ok: true,
        navigation,
      });
      expect(ports.pendingWorkspaceNavigation).toHaveBeenCalledWith(rendererSender);
      await expect(
        invoke("volli:settings-window-pending-workspace-navigation", {}),
      ).resolves.toEqual({ ok: false, error: "Invalid pending workspace navigation request" });
      expect(ports.pendingWorkspaceNavigation).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a failed workspace reveal as data", async () => {
    register({
      openWorkspace: async () => {
        throw new Error("Workspace renderer unavailable");
      },
    });
    await expect(
      invoke("volli:settings-window-open-workspace", WORKSPACE_NAVIGATIONS[0]),
    ).resolves.toEqual({ ok: false, error: "Workspace renderer unavailable" });
  });

  it("returns a refused workspace requester as data", async () => {
    register({
      pendingWorkspaceNavigation: () => {
        throw new Error("Not a workspace renderer");
      },
    });
    await expect(invoke("volli:settings-window-pending-workspace-navigation")).resolves.toEqual({
      ok: false,
      error: "Not a workspace renderer",
    });
  });

  it.each(WORKSPACE_NAVIGATIONS)(
    "targets one workspace renderer for a $kind reveal",
    (navigation) => {
      const target = {
        id: 82,
        send(channel: string, payload: unknown) {
          sent.push({ target: this.id, channel, payload: wire(payload) });
        },
      } as WebContents;
      sendWorkspaceWindowNavigation(target, navigation);
      expect(sent).toEqual([
        { target: 82, channel: "volli:workspace-window-navigate", payload: navigation },
      ]);
      expect(sent[0]!.payload).not.toBe(navigation);
    },
  );

  it("sends navigation to only the chosen target through the V8 codec", () => {
    const target = {
      id: 81,
      send(channel: string, payload: unknown) {
        sent.push({ target: this.id, channel, payload: wire(payload) });
      },
    } as WebContents;
    sendSettingsWindowNavigation(target, NAVIGATION);
    expect(sent).toEqual([
      { target: 81, channel: "volli:settings-window-navigate", payload: NAVIGATION },
    ]);
    expect(sent[0]!.payload).not.toBe(NAVIGATION);
  });
});

describe("Settings preload contract through the real registry and V8 codec", () => {
  let api: Api;
  beforeAll(async () => {
    // Preload's non-isolated test fallback, with no document or GUI involved.
    vi.stubGlobal("window", {});
    await import("../preload");
    api = (window as unknown as { api: Api }).api;
  });

  it("normalizes open() to {} so the sender remains the trailing handler argument", async () => {
    const ports = register();
    await expect(api.settingsWindow.open()).resolves.toEqual({ ok: true });
    expect(ports.open).toHaveBeenCalledWith({}, rendererSender);
    await expect(api.settingsWindow.open(NAVIGATION)).resolves.toEqual({ ok: true });
    expect(ports.open).toHaveBeenLastCalledWith(NAVIGATION, rendererSender);
  });

  it("separates the pre-mount read from the post-commit ready signal", async () => {
    const ports = register();
    await expect(api.settingsWindow.pendingNavigation()).resolves.toEqual({
      ok: true,
      navigation: NAVIGATION,
    });
    expect(ports.ready).not.toHaveBeenCalled();
    await expect(api.settingsWindow.ready(NAVIGATION.revision)).resolves.toEqual({
      ok: true,
      navigation: NAVIGATION,
    });
    expect(ports.ready).toHaveBeenCalledWith(NAVIGATION.revision, rendererSender);
  });

  it.each(WORKSPACE_NAVIGATIONS)(
    "routes a workspace $kind reveal through preload",
    async (input) => {
      const ports = register({ pendingWorkspaceNavigation: vi.fn(() => input) });
      await expect(api.settingsWindow.openWorkspace(input)).resolves.toEqual({ ok: true });
      expect(ports.openWorkspace).toHaveBeenCalledWith(input, rendererSender);
      await expect(api.settingsWindow.pendingWorkspaceNavigation()).resolves.toEqual({
        ok: true,
        navigation: input,
      });
      expect(ports.pendingWorkspaceNavigation).toHaveBeenCalledWith(rendererSender);
    },
  );

  it("subscribes to workspace reveals without leaking Electron events or other listeners", () => {
    const callback = vi.fn();
    const other = vi.fn();
    const unsubscribe = api.settingsWindow.onWorkspaceNavigate(callback);
    const unsubscribeOther = api.settingsWindow.onWorkspaceNavigate(other);
    const navigation = WORKSPACE_NAVIGATIONS[1]!;
    const deliver = () => {
      for (const listener of listeners.get("volli:workspace-window-navigate") ?? []) {
        listener({ sender: "must not reach the callback" }, wire(navigation));
      }
    };
    deliver();
    expect(callback).toHaveBeenCalledExactlyOnceWith(navigation);
    expect(callback.mock.calls[0]![0]).not.toBe(navigation);
    unsubscribe();
    deliver();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    unsubscribeOther();
    expect(listeners.get("volli:workspace-window-navigate")?.size).toBe(0);
  });

  it("preserves the legacy two-argument preference write and success shape", async () => {
    const legacy: AppStateSetResult = { ok: true };
    const request = vi.fn((_event: { sender: WebContents }, ..._args: unknown[]) => legacy);
    handlers.set("volli:app-state-set", request);
    await expect(api.appState.set("volli:ui", "next")).resolves.toEqual({ ok: true });
    await expect(api.appState.set("volli:ui", "next", undefined)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, { sender: rendererSender }, "volli:ui", "next");
    expect(request).toHaveBeenNthCalledWith(2, { sender: rendererSender }, "volli:ui", "next");
  });

  it("forwards a preference baseline and preserves the authoritative accepted value", async () => {
    const baseline = '{"state":{"sidebarWidth":240,"showCost":false}}';
    const next = '{"state":{"sidebarWidth":240,"showCost":true}}';
    const merged = '{"state":{"sidebarWidth":320,"showCost":true}}';
    const accepted: AppStateSetResult = { ok: true, value: merged };
    const request = vi.fn((_event: { sender: WebContents }, ..._args: unknown[]) => accepted);
    handlers.set("volli:app-state-set", request);
    await expect(api.appState.set("volli:ui", next, baseline)).resolves.toEqual({
      ok: true,
      value: merged,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { sender: rendererSender },
      "volli:ui",
      next,
      baseline,
    );
  });

  it("preserves a refused preference write with a supplied baseline", async () => {
    const refused: AppStateSetResult = { ok: false, error: "Preference write refused" };
    handlers.set("volli:app-state-set", () => refused);
    await expect(api.appState.set("volli:ui", "next", "before")).resolves.toEqual(refused);
  });

  it("delivers accepted cross-window preferences and unsubscribes independently", () => {
    const changed = { key: "ui", value: '{"state":{"sidebarCollapsed":true}}' };
    const callback = vi.fn();
    const other = vi.fn();
    const unsubscribe = api.appState.onChanged(callback);
    const unsubscribeOther = api.appState.onChanged(other);
    const deliver = () => {
      for (const listener of listeners.get("volli:app-state-changed") ?? []) {
        listener({ sender: "must not reach the callback" }, wire(changed));
      }
    };
    deliver();
    expect(callback).toHaveBeenCalledExactlyOnceWith(changed);
    expect(callback.mock.calls[0]![0]).not.toBe(changed);
    unsubscribe();
    deliver();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    unsubscribeOther();
    expect(listeners.get("volli:app-state-changed")?.size).toBe(0);
  });

  it("strips Electron's event and removes only its own navigation listener", () => {
    const callback = vi.fn();
    const other = vi.fn();
    const unsubscribe = api.settingsWindow.onNavigate(callback);
    const unsubscribeOther = api.settingsWindow.onNavigate(other);
    const deliver = () => {
      for (const listener of listeners.get("volli:settings-window-navigate") ?? []) {
        listener({ sender: "must not reach the callback" }, wire(NAVIGATION));
      }
    };
    deliver();
    expect(callback).toHaveBeenCalledExactlyOnceWith(NAVIGATION);
    expect(callback.mock.calls[0]![0]).not.toBe(NAVIGATION);
    unsubscribe();
    unsubscribe();
    deliver();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    unsubscribeOther();
    expect(listeners.get("volli:settings-window-navigate")?.size).toBe(0);
  });
});
