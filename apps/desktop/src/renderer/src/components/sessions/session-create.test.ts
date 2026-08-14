/**
 * The chat arm of the boot pipeline. What is under test is the GUARD, not the
 * store: `createChatSession` is stubbed on the singleton so each case can hold
 * the create open, refuse it, or answer it, and the assertions are about what
 * the pipeline does around that answer.
 */
import type { Project } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { scratchScope, ticketScope } from "@renderer/stores/sessions";
import { bootChatSession, terminalCreateRequest } from "./session-create";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// The engine registry reaches for restty/WebGPU on import and no chat boot
// touches it; the terminal arm is exercised in the live smokes.
vi.mock("@renderer/terminal/registry", () => ({
  disposeEngine: vi.fn(),
  getOrCreateEngine: vi.fn(),
}));

const PROJECT: Project = {
  id: "p1",
  name: "Volli",
  path: "/tmp/volli",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const SCOPE = ticketScope("p1", "t1");

function stubChatStore(createChatSession: () => Promise<string | null>) {
  const closeChatSession = vi.fn();
  useChatSessionsStore.setState({ createChatSession, closeChatSession });
  return { closeChatSession };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [PROJECT] });
  useChatSessionsStore.setState({ starting: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootChatSession", () => {
  it("mints the Session under the scope's ticket and lands its tab", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);
    const land = vi.fn(() => true);

    const sessionId = await bootChatSession(SCOPE, { title: "Chat 1", land });

    expect(sessionId).toBe("durable-1");
    expect(create).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: "t1",
      title: "Chat 1",
    });
    expect(land).toHaveBeenCalledWith("durable-1");
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("routes a scratch scope as a ticketless Session", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);

    await bootChatSession(
      { kind: "scratch", projectId: "p1" },
      {
        title: "Chat 1",
        land: () => true,
      },
    );

    expect(create).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: null,
      title: "Chat 1",
    });
  });

  it("holds one create per owner, and hands the second nothing", async () => {
    let release!: (sessionId: string) => void;
    const create = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    stubChatStore(create);

    const first = bootChatSession(SCOPE, { title: "Chat 1", land: () => true });
    expect(useChatSessionsStore.getState().starting).toEqual({ t1: true });
    const second = await bootChatSession(SCOPE, { title: "Chat 2", land: () => true });

    expect(second).toBeNull();
    expect(create).toHaveBeenCalledOnce();

    release("durable-1");
    await expect(first).resolves.toBe("durable-1");
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("never creates into a project the renderer has stopped tracking", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);
    useProjectsStore.setState({ projects: [] });

    await expect(bootChatSession(SCOPE, { title: "Chat 1", land: () => true })).resolves.toBeNull();

    expect(create).not.toHaveBeenCalled();
  });

  /** A refused ATTACH still resolves an id (see chat-sessions.test.ts): the
   * Session exists, and the tab it opens carries its own Retry. Landing is
   * gated on the create alone, so the boot cannot tell the two apart — which is
   * the contract. */
  it("opens the tab on whatever the create resolved", async () => {
    stubChatStore(async () => "durable-1");
    const land = vi.fn(() => true);

    await expect(bootChatSession(SCOPE, { title: "Chat 1", land })).resolves.toBe("durable-1");

    expect(land).toHaveBeenCalledOnce();
  });

  it("opens no tab when the create itself left nothing durable behind", async () => {
    const { closeChatSession } = stubChatStore(async () => null);
    const land = vi.fn(() => true);

    await expect(bootChatSession(SCOPE, { title: "Chat 1", land })).resolves.toBeNull();

    expect(land).not.toHaveBeenCalled();
    expect(closeChatSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("lets the Session go when the owner vanished mid-flight", async () => {
    const { closeChatSession } = stubChatStore(async () => "durable-1");

    await expect(
      bootChatSession(SCOPE, { title: "Chat 1", land: () => false }),
    ).resolves.toBeNull();

    expect(closeChatSession).toHaveBeenCalledWith("durable-1");
  });

  it("lets it go for a project removed while the create was in flight", async () => {
    const { closeChatSession } = stubChatStore(async () => {
      useProjectsStore.setState({ projects: [] });
      return "durable-1";
    });
    const land = vi.fn(() => true);

    await expect(bootChatSession(SCOPE, { title: "Chat 1", land })).resolves.toBeNull();

    expect(land).not.toHaveBeenCalled();
    expect(closeChatSession).toHaveBeenCalledWith("durable-1");
  });

  it("toasts and clears the flag when the create throws, rather than latching the surface shut", async () => {
    stubChatStore(async () => {
      throw new Error("socket hang up");
    });

    await expect(bootChatSession(SCOPE, { title: "Chat 1", land: () => true })).resolves.toBeNull();

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start chat: socket hang up",
      expect.anything(),
    );
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });
});

describe("terminalCreateRequest", () => {
  it("sends Ticket identity alone when a ticket scope carries no kickoff or resume", () => {
    expect(terminalCreateRequest(SCOPE, PROJECT.path, "tab")).toEqual({
      workspaceId: PROJECT.id,
      cwd: PROJECT.path,
      cols: 80,
      rows: 24,
      placement: "tab",
      ticket: { ticketId: "t1" },
    });
  });

  it("invents no Ticket for a scratch scope", () => {
    expect(terminalCreateRequest(scratchScope(PROJECT.id), PROJECT.path, "tab")).toEqual({
      workspaceId: PROJECT.id,
      cwd: PROJECT.path,
      cols: 80,
      rows: 24,
      placement: "tab",
    });
  });
});
