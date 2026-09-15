/**
 * The chat arm of the boot pipeline. What is under test is the GUARD, not the
 * store: `createChatSession` is stubbed on the singleton so each case can hold
 * the create open, refuse it, or answer it, and the assertions are about what
 * the pipeline does around that answer.
 */
import type { Project, Ticket } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { useBoardStore } from "@renderer/stores/board";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { projectScope, ticketScope } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { bootChatSession, startTicketChat, terminalCreateRequest } from "./session-create";

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
const TICKET: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "Auto-title composed starts",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

function stubChatStore(createChatSession: () => Promise<string | null>) {
  const closeChatSession = vi.fn();
  useChatSessionsStore.setState({ createChatSession, closeChatSession });
  return { closeChatSession };
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [PROJECT] });
  useBoardStore.setState({ ticketsByProject: { p1: [TICKET] } });
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ starting: {}, openTabs: {}, provisionalActive: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A v4 UUID, the ONLY shape a client may propose as a durable Session id.
 *
 * `docs/BOUNDARIES.md` rule 1 bars a machine-local ingredient, and a v1 UUID
 * carries the minting machine's MAC; the RPC door refuses anything else
 * (`z.uuidv4()`), so `expect.any(String)` here would let a change to the mint
 * pass this file and fail at the edge instead.
 */
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

describe("bootChatSession", () => {
  it("opens a ticket Draft immediately without creating a Session", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);
    const land = vi.fn(() => true);

    const sessionId = await bootChatSession(SCOPE, { land });

    expect(sessionId).toMatch(UUID_V4);
    expect(create).not.toHaveBeenCalled();
    expect(land).toHaveBeenCalledWith(sessionId, false);
    const provisional = useChatDraftsStore.getState().drafts[sessionId!]?.provisional;
    expect(provisional).toMatchObject({
      projectId: "p1",
      ticketId: "t1",
      title: null,
      phase: "draft",
    });
    // Two ids, minted separately and never the same one: the Draft id becomes
    // the Session's, while the operation id is the create command's key, so a
    // retry replays one command rather than minting a second Session.
    expect(provisional?.operationId).toMatch(UUID_V4);
    expect(provisional?.operationId).not.toBe(sessionId);
    expect(useChatSessionsStore.getState().provisionalActive).toEqual({ t1: sessionId });
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("records a scratch Draft as ticketless while still performing no create RPC", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);

    const sessionId = await bootChatSession(
      { kind: "project", projectId: "p1" },
      { land: () => true },
    );

    expect(create).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts[sessionId!]?.provisional).toMatchObject({
      projectId: "p1",
      ticketId: null,
    });
  });

  it("keeps kickoff on the immediate Session path", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);
    const land = vi.fn(() => true);

    await expect(bootChatSession(SCOPE, { createsSessionNow: true, land })).resolves.toBe(
      "durable-1",
    );

    expect(create).toHaveBeenCalledWith({ projectId: "p1", ticketId: "t1", title: null });
    expect(land).toHaveBeenCalledWith("durable-1", true);
    expect(useChatDraftsStore.getState().drafts).toEqual({});
  });

  it("holds one immediate create per owner, and hands the second nothing", async () => {
    let release!: (sessionId: string) => void;
    const create = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    stubChatStore(create);

    const first = bootChatSession(SCOPE, { createsSessionNow: true, land: () => true });
    expect(useChatSessionsStore.getState().starting).toEqual({ t1: true });
    const second = await bootChatSession(SCOPE, { createsSessionNow: true, land: () => true });

    expect(second).toBeNull();
    expect(create).toHaveBeenCalledOnce();

    release("durable-1");
    await expect(first).resolves.toBe("durable-1");
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("never opens a Draft into a project the renderer has stopped tracking", async () => {
    const create = vi.fn(async () => "durable-1");
    stubChatStore(create);
    useProjectsStore.setState({ projects: [] });

    await expect(bootChatSession(SCOPE, { land: () => true })).resolves.toBeNull();

    expect(create).not.toHaveBeenCalled();
    expect(useChatDraftsStore.getState().drafts).toEqual({});
  });

  it("discards a provisional Draft that cannot land", async () => {
    stubChatStore(async () => "durable-1");

    await expect(bootChatSession(SCOPE, { land: () => false })).resolves.toBeNull();

    expect(useChatDraftsStore.getState().drafts).toEqual({});
  });

  it("opens no tab when an immediate create left nothing durable behind", async () => {
    const { closeChatSession } = stubChatStore(async () => null);
    const land = vi.fn(() => true);

    await expect(bootChatSession(SCOPE, { createsSessionNow: true, land })).resolves.toBeNull();

    expect(land).not.toHaveBeenCalled();
    expect(closeChatSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });

  it("lets an immediately created Session go when its owner vanished mid-flight", async () => {
    const { closeChatSession } = stubChatStore(async () => "durable-1");

    await expect(
      bootChatSession(SCOPE, { createsSessionNow: true, land: () => false }),
    ).resolves.toBeNull();

    expect(closeChatSession).toHaveBeenCalledWith("durable-1");
  });

  it("toasts and clears the flag when an immediate create throws", async () => {
    stubChatStore(async () => {
      throw new Error("socket hang up");
    });

    await expect(
      bootChatSession(SCOPE, { createsSessionNow: true, land: () => true }),
    ).resolves.toBeNull();

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start chat: socket hang up",
      expect.anything(),
    );
    expect(useChatSessionsStore.getState().starting).toEqual({});
  });
});

describe("startTicketChat", () => {
  function startHarness() {
    stubChatStore(async () => "durable-1");
    const enqueue = vi.fn();
    useChatSessionsStore.setState({ enqueue, openChatTab: vi.fn() });
    useWorkspaceStore.setState({ setTicketActiveTab: vi.fn() });
    return { enqueue };
  }

  it("carries a composed start's fallback as the opening message auto-title baseline", async () => {
    const { enqueue } = startHarness();
    const message = "Begin work on this ticket. Your assignment is the Ticket Brief above.";

    await startTicketChat("p1", "t1", {
      title: "Work on VC-1",
      refineTitle: true,
      message,
    });

    expect(enqueue).toHaveBeenCalledWith("durable-1", {
      id: expect.any(String),
      text: message,
      autoTitleBaseline: "Work on VC-1",
    });
  });

  it("does not make an ordinary explicit title eligible for refinement", async () => {
    const { enqueue } = startHarness();

    await startTicketChat("p1", "t1", {
      title: "My review",
      message: "Begin the review",
    });

    expect(enqueue).toHaveBeenCalledWith("durable-1", {
      id: expect.any(String),
      text: "Begin the review",
    });
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
    expect(terminalCreateRequest(projectScope(PROJECT.id), PROJECT.path, "tab")).toEqual({
      workspaceId: PROJECT.id,
      cwd: PROJECT.path,
      cols: 80,
      rows: 24,
      placement: "tab",
    });
  });
});
