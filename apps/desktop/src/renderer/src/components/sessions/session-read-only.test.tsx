// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { projectScope, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { NewSessionControl } from "./new-session-control";
import { bootChatSession, createTerminalSession, startProjectChat } from "./session-create";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const cloud = vi.hoisted(() => ({ connected: null as boolean | null }));
vi.mock("@renderer/lib/cloud-client", () => ({
  cloudSession: () =>
    cloud.connected === null
      ? null
      : { client: { connectionState: () => ({ isWebSocketConnected: cloud.connected }) } },
}));
// This suite owns the connection gate. Runner discovery is already ready;
// its subscription and unavailable-runner states have their own picker tests.
vi.mock("@renderer/components/chat/runner-picker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/components/chat/runner-picker")>();
  const runner = {
    id: "mac",
    name: "This Mac",
    kind: "mac",
    status: "online",
    statusChangedAt: 1,
    providers: [],
    version: "1",
    upgradeRequired: false,
  };
  return {
    ...actual,
    useRunnerPicker: () => ({
      runners: [runner],
      selected: runner,
      thisMacId: "mac",
      loading: false,
      error: null,
      choose: vi.fn(),
    }),
  };
});
vi.mock("@renderer/terminal/registry", () => ({
  disposeEngine: vi.fn(),
  getOrCreateEngine: vi.fn(),
}));

const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const REASON = "Can’t reach hetzner-1 · Read-only";
const originalChat = useChatSessionsStore.getState();
const originalDrafts = useChatDraftsStore.getState();
const originalSessions = useSessionsStore.getState();
const originalProjects = useProjectsStore.getState();
const create = vi.fn(async () => ({ ok: false, error: "test refusal" }));
let world: HostWorld | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  cloud.connected = null;
  vi.stubGlobal("api", {
    terminal: { create },
    appState: { set: vi.fn(async () => ({ ok: true })) },
  });
  useChatSessionsStore.setState({ starting: {}, openTabs: {}, provisionalActive: {} });
  useSessionsStore.setState({ starting: {}, byOwner: {} });
  useChatDraftsStore.setState({ drafts: {} });
});

afterEach(async () => {
  adoptLaunch(LOCAL_LAUNCH);
  await world?.cleanup();
  world = null;
  useChatSessionsStore.setState(originalChat, true);
  useChatDraftsStore.setState(originalDrafts, true);
  useSessionsStore.setState(originalSessions, true);
  useProjectsStore.setState(originalProjects, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function control(projectId: string, onNewChat = vi.fn()) {
  return (
    <NewSessionControl
      projectId={projectId}
      disabled={false}
      onNewChat={onNewChat}
      onNewTerminal={() => {}}
    />
  );
}

function newChat(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New chat"]');
  if (button === null) throw new Error("Missing New chat button");
  return button;
}

describe("NewSessionControl host read-only", () => {
  it("offers cloud chat but refuses unconnected starts and keeps terminal creation unavailable", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    world = hostWorld({ cloud: true });
    const onNewChat = vi.fn();
    const container = await world.render(control("local", onNewChat));
    expect(newChat(container).disabled).toBe(false);
    expect(container.querySelector('[aria-label="Not available yet in cloud"]')).toBeNull();
    newChat(container).click();
    expect(onNewChat).toHaveBeenCalledOnce();
    // The control follows the cloud link. The semantic start also checks the
    // actual client at the press; this fixture has none, so it opens no draft
    // and never falls back to a local durable Session or terminal.
    const durableCreate = vi.spyOn(useChatSessionsStore.getState(), "createChatSession");
    await startProjectChat("local");
    expect(await createTerminalSession(projectScope("local"))).toBeNull();
    expect(useChatDraftsStore.getState().drafts).toEqual({});
    expect(durableCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Volli Cloud is not connected", {
      id: "cloud-session-not-connected",
    });
    expect(toast).toHaveBeenCalledWith("Not available yet in cloud", {
      id: "cloud-session-read-only",
    });
  });
  it("disables and marks the wrapper offline, then restores it when the host opens", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const onNewChat = vi.fn();
    const container = await world.render(control("remote", onNewChat));
    const button = newChat(container);
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.hasAttribute("data-host-read-only")).toBe(true);
    button.click();
    expect(onNewChat).not.toHaveBeenCalled();
    world.setHetzner({ link: { status: "open" } });
    expect(button.disabled).toBe(false);
    expect(button.parentElement?.hasAttribute("data-host-read-only")).toBe(false);
  });

  it("does not stand down with the cloud flag off, even offline", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const container = await world.render(control("remote"));
    expect(newChat(container).disabled).toBe(false);
    expect(container.querySelector("[data-host-read-only]")).toBeNull();
  });

  it("never stands This Mac's project down for an offline remote host", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(control("local"));
    expect(newChat(container).disabled).toBe(false);
    expect(container.querySelector("[data-host-read-only]")).toBeNull();
  });
});

describe("Session creation host read-only", () => {
  it.each([projectScope("local"), ticketScope("local", "t1")])(
    "opens connected cloud chat doors without a legacy Workspace grant (%j)",
    async (scope) => {
      adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
      cloud.connected = true;
      world = hostWorld({ cloud: true });
      const durableCreate = vi
        .spyOn(useChatSessionsStore.getState(), "createChatSession")
        .mockResolvedValue("cloud-session");
      const land = vi.fn(() => true);

      const draftId = await bootChatSession(scope, { land });
      expect(draftId).not.toBeNull();
      expect(land).toHaveBeenCalledWith(draftId, false);
      expect(useChatDraftsStore.getState().drafts[draftId!]?.provisional).toMatchObject({
        projectId: "local",
        ticketId: scope.kind === "ticket" ? "t1" : null,
        phase: "draft",
      });
      expect(durableCreate).not.toHaveBeenCalled();
      await expect(bootChatSession(scope, { createsSessionNow: true, land })).resolves.toBe(
        "cloud-session",
      );
      expect(durableCreate).toHaveBeenCalledExactlyOnceWith({
        projectId: "local",
        ticketId: scope.kind === "ticket" ? "t1" : null,
        title: null,
      });
      expect(land).toHaveBeenLastCalledWith("cloud-session", true);
      expect(toast).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

      // A socket lost between drawing the button and pressing it still
      // refuses before a Draft or durable create, even without a host grant.
      cloud.connected = false;
      const drafts = useChatDraftsStore.getState().drafts;
      await expect(bootChatSession(scope, { land })).resolves.toBeNull();
      await expect(bootChatSession(scope, { createsSessionNow: true, land })).resolves.toBeNull();
      expect(useChatDraftsStore.getState().drafts).toBe(drafts);
      expect(durableCreate).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith("Volli Cloud is not connected", {
        id: "cloud-session-not-connected",
      });
    },
  );

  it("refuses both chat doors and terminal creation without opening a draft or contacting main", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const land = vi.fn(() => true);
    const open = vi.spyOn(useChatDraftsStore.getState(), "openProvisional");
    const durableCreate = vi.spyOn(useChatSessionsStore.getState(), "createChatSession");

    await expect(bootChatSession(projectScope("remote"), { land })).resolves.toBeNull();
    await expect(startProjectChat("remote")).resolves.toBeUndefined();
    await expect(createTerminalSession(projectScope("remote"))).resolves.toBeNull();

    expect(land).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(durableCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts).toEqual({});
    expect(useChatSessionsStore.getState().openTabs).toEqual({});
    expect(useChatSessionsStore.getState().provisionalActive).toEqual({});
    expect(toast).toHaveBeenCalledTimes(3);
    expect(toast.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [REASON, { id: "host-read-only" }]),
    );
  });

  it("lets both chat doors open provisional drafts with the flag off", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const land = vi.fn(() => true);
    const sessionId = await bootChatSession(projectScope("remote"), { land });
    expect(sessionId).not.toBeNull();
    expect(land).toHaveBeenCalledWith(sessionId, false);
    expect(useChatDraftsStore.getState().drafts[sessionId!]?.provisional).toMatchObject({
      projectId: "remote",
      ticketId: null,
      phase: "draft",
    });
    await startProjectChat("remote");
    expect(Object.keys(useChatDraftsStore.getState().drafts)).toHaveLength(2);
    expect(useChatSessionsStore.getState().openTabs.remote).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("reaches terminal.create with the flag off despite the offline host", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    // Main's deliberate refusal avoids mounting a terminal; reaching main is
    // the flag-off contract, not a fake successful PTY lifecycle.
    await expect(createTerminalSession(projectScope("remote"))).resolves.toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "remote", cwd: "/Users/me/remote" }),
    );
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start session: test refusal",
      expect.anything(),
    );
  });
});
