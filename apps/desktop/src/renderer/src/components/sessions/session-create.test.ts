// @vitest-environment jsdom
/**
 * The chat arm of the boot pipeline. What is under test is the GUARD, not the
 * store: `createChatSession` is stubbed on the singleton so each case can hold
 * the create open, refuse it, or answer it, and the assertions are about what
 * the pipeline does around that answer.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Project, Ticket } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { useBoardStore } from "@renderer/stores/board";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { remoteHost } from "@renderer/stores/host-sources";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { projectScope, ticketScope } from "@renderer/stores/sessions";
import {
  createWorkspaceStore,
  DEFAULT_WORKSPACE_UI,
  useWorkspaceStore,
  type WorkspaceUiState,
} from "@renderer/stores/workspace";
import { useNavHistory } from "@renderer/hooks/use-nav-history";
import { runKickoff } from "@renderer/components/board/new-ticket/submit";
import { bootChatSession, startTicketChat, terminalCreateRequest } from "./session-create";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
// The engine registry pulls in xterm.js and its stylesheet on import and no
// chat boot touches it; the terminal arm is exercised in the live smokes.
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

const originalChatState = useChatSessionsStore.getState();
const originalBoardState = useBoardStore.getState();
const originalProjectsState = useProjectsStore.getState();
const originalHostsState = useHostConnectionStore.getState();
const originalExperimentsState = useExperimentsStore.getState();

function HistoryRecorder() {
  useNavHistory();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  // setState-installed doubles are not restored by restoreAllMocks. Restore
  // the singleton's real actions as well as its data before every case.
  useChatSessionsStore.setState(originalChatState, true);
  useProjectsStore.setState({ ...originalProjectsState, projects: [PROJECT] }, true);
  useBoardStore.setState({ ...originalBoardState, ticketsByProject: { p1: [TICKET] } }, true);
  useChatDraftsStore.setState({ drafts: {} });
  const workspace = createWorkspaceStore({
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.spyOn(useWorkspaceStore, "getState").mockImplementation(workspace.getState);
  vi.spyOn(useWorkspaceStore, "subscribe").mockImplementation(workspace.subscribe);
});

afterEach(() => {
  vi.restoreAllMocks();
  useChatSessionsStore.setState(originalChatState, true);
  useBoardStore.setState(originalBoardState, true);
  useProjectsStore.setState(originalProjectsState, true);
  useHostConnectionStore.setState(originalHostsState, true);
  useExperimentsStore.setState(originalExperimentsState, true);
  vi.unstubAllGlobals();
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

function remoteProject(granted: readonly string[] | undefined, cloud = true) {
  useExperimentsStore.setState({ snapshot: { cloud: { enabled: cloud, source: "storage" } } });
  useHostConnectionStore.setState({
    hosts: [
      remoteHost("box", "box", { hostScope: { status: "ready", granted: ["host.workspaces"] } }),
    ],
    projects: {
      p1: {
        hostId: "box",
        link: { status: "open" },
        ...(granted === undefined ? {} : { granted }),
      },
    },
  });
}

describe("bootChatSession", () => {
  it.each([ticketScope("p1", "t1"), projectScope("p1")])(
    "opens a remote chat Draft only with this project's sessions grant (%j)",
    async (scope) => {
      remoteProject(["sessions"]);
      const create = vi.fn(async () => "durable-remote");
      stubChatStore(create);
      const id = await bootChatSession(scope, { land: () => true });
      expect(id).toMatch(UUID_V4);
      expect(useChatDraftsStore.getState().drafts[id!]?.provisional).toMatchObject({
        projectId: "p1",
        ticketId: scope.kind === "ticket" ? "t1" : null,
      });
      expect(create).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
      await expect(
        bootChatSession(scope, { createsSessionNow: true, land: () => true }),
      ).resolves.toBe("durable-remote");
      expect(create).toHaveBeenCalledWith({
        projectId: "p1",
        ticketId: scope.kind === "ticket" ? "t1" : null,
        title: null,
      });
    },
  );

  it.each([undefined, [], ["board", "host.logs"]])(
    "keeps older/unknown remote Sessions named and unavailable (%j)",
    async (granted) => {
      remoteProject(granted);
      const create = vi.fn(async () => "must-not-create");
      stubChatStore(create);
      const land = vi.fn(() => true);
      for (const scope of [SCOPE, projectScope("p1")]) {
        await expect(bootChatSession(scope, { land })).resolves.toBeNull();
        await expect(bootChatSession(scope, { createsSessionNow: true, land })).resolves.toBeNull();
      }
      expect(create).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(useChatDraftsStore.getState().drafts).toEqual({});
      expect(toast).toHaveBeenCalledWith("Not available on box yet", { id: "host-local-only" });
    },
  );

  it("leaves cloud-off chat doors unchanged despite a remote-looking source", async () => {
    remoteProject([], false);
    stubChatStore(vi.fn(async () => "local-session"));
    await expect(
      bootChatSession(SCOPE, { createsSessionNow: true, land: () => true }),
    ).resolves.toBe("local-session");
    expect(toast).not.toHaveBeenCalled();
  });
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

  it.each([
    undefined,
    { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" } as const,
  ])(
    "offers ticket task text at immediate birth, preserving explicit picks (%s)",
    async (model) => {
      const create = vi.fn(async () => "durable-1");
      stubChatStore(create);
      await startTicketChat("p1", "t1", {
        message: "Begin work on this ticket.",
        autoSelect: { request: "Fix the database race\n\nReproduce concurrent writes." },
        ...(model === undefined ? {} : { model }),
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          autoSelect: { request: "Fix the database race\n\nReproduce concurrent writes." },
          ...(model === undefined ? {} : { model }),
        }),
      );
    },
  );

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
    useChatSessionsStore.setState({ enqueue });
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

describe("Create & start keeps the current workspace (VC-491)", () => {
  it.each([
    ["board", "home", "board", null, "p1"],
    ["project file", "home", "file:README.md", null, "p1"],
    ["project chat", "home", "chat:existing", null, "p1"],
    ["another ticket", "home", "board", "existing-ticket", "p1"],
    ["Configure", "configure", "board", null, "p1"],
    ["another project", "home", "board", null, "p2"],
  ] as const)(
    "starts from %s without changing selection",
    async (_name, nav, homeActiveTab, openTicketId, selectedProjectId) => {
      const workspace = createWorkspaceStore({
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      const current: WorkspaceUiState = {
        ...DEFAULT_WORKSPACE_UI,
        nav,
        homeActiveTab,
        openTicketId,
        projectFiles: {
          tabs: [{ relPath: "README.md", pinned: true }],
          activeRelPath: "README.md",
        },
        projectFileViewStates: { "README.md": { cursor: 12 } },
        homeTabOrder: ["chat:existing", "file:README.md"],
        homeTabHistory: ["board", "file:README.md", "chat:existing"],
        ticketTabs: {
          "existing-ticket": {
            files: [{ relPath: "src/index.ts", pinned: true }],
            diffs: ["src/index.ts"],
            diffMeta: { "src/index.ts": { status: "modified" } },
            tabOrder: ["chat:existing-ticket-chat", "diff:src/index.ts", "file:src/index.ts"],
            active: "chat:existing-ticket-chat",
          },
        },
      };
      const otherProject: WorkspaceUiState = {
        ...DEFAULT_WORKSPACE_UI,
        homeActiveTab: "chat:other-project-chat",
        homeTabOrder: ["chat:other-project-chat", "file:CONTRIBUTING.md"],
        homeTabHistory: ["board", "file:CONTRIBUTING.md", "chat:other-project-chat"],
        projectFiles: {
          tabs: [{ relPath: "CONTRIBUTING.md", pinned: true }],
          activeRelPath: "CONTRIBUTING.md",
        },
      };
      workspace.setState({ byProject: { p1: current, p2: otherProject } });
      vi.spyOn(useWorkspaceStore, "getState").mockImplementation(workspace.getState);
      vi.spyOn(useWorkspaceStore, "subscribe").mockImplementation(workspace.subscribe);
      useProjectsStore.setState({
        projects: [PROJECT, { ...PROJECT, id: "p2" }],
        selectedProjectId,
      });
      const selectedByProject = {
        p1: ["existing-ticket", "selected-sibling"],
        p2: ["other-project-ticket"],
      };
      useBoardStore.setState({
        ticketsByProject: {
          p1: [TICKET, { ...TICKET, id: "existing-ticket" }, { ...TICKET, id: "selected-sibling" }],
          p2: [{ ...TICKET, projectId: "p2", id: "other-project-ticket" }],
        },
        selectedByProject,
      });
      const create = vi.fn(async () => "durable-1");
      stubChatStore(create);
      const enqueue = vi.fn();
      useChatSessionsStore.setState({ enqueue });
      const chatStore = useChatSessionsStore.getState();
      chatStore.openChatTab("p1", "existing");
      chatStore.openChatTab("existing-ticket", "existing-ticket-chat");
      chatStore.openChatTab("p2", "other-project-chat");
      const openTabs = useChatSessionsStore.getState().openTabs;
      const toastSuccess = vi.fn();

      // Mount the actual recorder so a navigation regression would record a
      // new location and discard Forward, rather than merely comparing an
      // inert empty history that no subscriber can ever change.
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => root.render(createElement(HistoryRecorder)));
      const location = {
        projectId: selectedProjectId,
        nav: selectedProjectId === "p1" ? nav : "home",
        openTicketId: selectedProjectId === "p1" ? openTicketId : null,
      } as const;
      workspace.getState().recordNav({ projectId: "p2", nav: "configure", openTicketId: null });
      workspace.getState().recordNav(location);
      const forward = { projectId: "p1", nav: "automations", openTicketId: null } as const;
      workspace.getState().recordNav(forward);
      expect(workspace.getState().stepNavBack()).toEqual(location);
      const history = workspace.getState().navHistory;
      expect(history.back.length).toBeGreaterThan(0);
      expect(history.forward).toEqual([forward]);

      try {
        await act(async () => {
          await expect(
            runKickoff(
              {
                projectId: "p1",
                ticketPrefix: "VC",
                status: "backlog",
                priority: "medium",
                title: TICKET.title,
                body: TICKET.body,
                labels: [],
                usesWorktree: true,
                baseBranch: "main",
              },
              {
                addTicket: vi.fn(async () => TICKET),
                startChat: startTicketChat,
                toastSuccess,
                runAutomation: vi.fn(async () => {}),
              },
              {},
            ),
          ).resolves.toEqual({ created: true });
        });

        const after = workspace.getState();
        // Only the NEW ticket's dormant tab is prepared. Every visible selection
        // and the navigation history stay exactly where the person left them.
        expect(after.byProject.p1).toEqual({
          ...current,
          ticketTabs: {
            ...current.ticketTabs,
            t1: expect.objectContaining({ active: "chat:durable-1" }),
          },
        });
        expect(after.byProject.p2).toBe(otherProject);
        expect(after.navHistory).toBe(history);
        expect(useProjectsStore.getState().selectedProjectId).toBe(selectedProjectId);
        expect(useBoardStore.getState().selectedByProject).toBe(selectedByProject);
        expect(useBoardStore.getState().selectedByProject).toEqual({
          p1: ["existing-ticket", "selected-sibling"],
          p2: ["other-project-ticket"],
        });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ ticketId: "t1" }));
        expect(useChatSessionsStore.getState().openTabs).toEqual({
          ...openTabs,
          t1: ["durable-1"],
        });
        expect(enqueue).toHaveBeenCalledWith(
          "durable-1",
          expect.objectContaining({
            text: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
          }),
        );
        expect(toastSuccess).toHaveBeenCalledWith("VC-1 created");

        // Positive control: the same mounted recorder DOES observe an actual
        // navigation and invalidate Forward. Dormant-tab preparation must not.
        const nextNav = location.nav === "home" ? "configure" : "home";
        workspace.getState().setNav(selectedProjectId, nextNav);
        expect(workspace.getState().navHistory.current).toEqual({ ...location, nav: nextNav });
        expect(workspace.getState().navHistory.forward).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
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
