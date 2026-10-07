// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { projectScope, useSessionsStore } from "@renderer/stores/sessions";
import { NewSessionControl } from "./new-session-control";
import { bootChatSession, createTerminalSession, startProjectChat } from "./session-create";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
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
  vi.stubGlobal("api", {
    terminal: { create },
    appState: { set: vi.fn(async () => ({ ok: true })) },
  });
  useChatSessionsStore.setState({ starting: {}, openTabs: {}, provisionalActive: {} });
  useSessionsStore.setState({ starting: {}, byOwner: {} });
  useChatDraftsStore.setState({ drafts: {} });
});

afterEach(async () => {
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
