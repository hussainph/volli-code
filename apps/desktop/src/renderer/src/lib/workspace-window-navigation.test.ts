import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";

const seams = vi.hoisted(() => {
  const session = { client: { connectionState: vi.fn(() => ({ isWebSocketConnected: true })) } };
  return {
    mode: "local" as "local" | "cloud",
    session: session as typeof session | null,
    sessionFixture: session,
    projects: { projects: [] as { id: string }[], select: vi.fn() },
    workspace: { workspace: null as { id: string; name: string } | null, projectsReady: false },
    link: {
      input: {
        online: true,
        snapshotAt: null as number | null,
        client: "running" as "starting" | "running" | "closed",
        authenticated: true as boolean | null,
        account: null as { failure: string | null } | null,
      },
    },
    listeners: {
      projects: new Set<() => void>(),
      workspace: new Set<() => void>(),
      link: new Set<() => void>(),
      session: new Set<() => void>(),
    },
    selectWorkspace:
      vi.fn<(id: string, session?: unknown, signal?: AbortSignal) => Promise<void>>(),
    setNav: vi.fn(),
    pinHomeFile: vi.fn(),
    openTicketView: vi.fn(),
    toastError: vi.fn(),
  };
});

vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: {
    getState: () => seams.projects,
    subscribe: (listener: () => void) => {
      seams.listeners.projects.add(listener);
      return () => seams.listeners.projects.delete(listener);
    },
  },
}));
vi.mock("@renderer/stores/project-ui", () => ({
  useProjectUiStore: {
    getState: () => ({
      setNav: seams.setNav,
      pinHomeFile: seams.pinHomeFile,
      openTicketView: seams.openTicketView,
    }),
  },
}));
vi.mock("@renderer/stores/launch", () => ({ launchStore: () => seams.mode }));
vi.mock("@renderer/stores/cloud-board/workspace", () => ({
  selectCloudWorkspace: seams.selectWorkspace,
  useCloudWorkspaceStore: {
    getState: () => seams.workspace,
    subscribe: (listener: () => void) => {
      seams.listeners.workspace.add(listener);
      return () => seams.listeners.workspace.delete(listener);
    },
  },
}));
vi.mock("@renderer/stores/cloud-link", () => ({
  useCloudLinkInputs: {
    getState: () => seams.link,
    subscribe: (listener: () => void) => {
      seams.listeners.link.add(listener);
      return () => seams.listeners.link.delete(listener);
    },
  },
}));
vi.mock("@renderer/stores/cloud-board/source", () => ({ CLOUD_READ_ONLY: "Cloud is read-only" }));
vi.mock("./cloud-board-api", () => ({ NOT_CONNECTED: "Cloud is not connected" }));
vi.mock("./cloud-client", () => ({
  cloudSession: () => seams.session,
  followCloudSession: (listener: () => void) => {
    seams.listeners.session.add(listener);
    if (seams.session !== null) listener();
    return () => seams.listeners.session.delete(listener);
  },
}));
vi.mock("./toast", () => ({ toastError: seams.toastError }));

function notify() {
  for (const listeners of Object.values(seams.listeners)) {
    for (const listener of Array.from(listeners)) listener();
  }
}
function cloudWorkspace(id: string, projectIds: string[], ready = true) {
  seams.mode = "cloud";
  seams.workspace.workspace = { id, name: id };
  seams.workspace.projectsReady = ready;
  seams.projects.projects = projectIds.map((projectId) => ({ id: projectId }));
  notify();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function expectNoListeners() {
  for (const listeners of Object.values(seams.listeners)) expect(listeners.size).toBe(0);
}
const requests: AbortController[] = [];
function request() {
  const controller = new AbortController();
  requests.push(controller);
  return controller;
}

let routing: typeof import("./workspace-window-navigation");
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  seams.selectWorkspace.mockReset().mockResolvedValue(undefined);
  seams.mode = "local";
  seams.session = seams.sessionFixture;
  seams.sessionFixture.client.connectionState.mockReturnValue({ isWebSocketConnected: true });
  seams.projects.projects = [];
  Object.assign(seams.workspace, { workspace: null, projectsReady: false });
  Object.assign(seams.link.input, {
    online: true,
    snapshotAt: null,
    client: "running",
    authenticated: true,
    account: null,
  });
  for (const listeners of Object.values(seams.listeners)) listeners.clear();
  routing = await import("./workspace-window-navigation");
});
afterEach(async () => {
  for (const controller of requests.splice(0)) controller.abort();
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("workspace-window presentation", () => {
  it("selects the local project before explicitly opening a file in Home", async () => {
    seams.projects.projects = [{ id: "p1" }];
    routing.acceptWorkspaceNavigation({ kind: "file", projectId: "p1", relPath: "AGENTS.md" });
    await settle();
    expect(seams.projects.select).toHaveBeenCalledExactlyOnceWith("p1");
    expect(seams.setNav).toHaveBeenCalledExactlyOnceWith("p1", "home");
    expect(seams.pinHomeFile).toHaveBeenCalledExactlyOnceWith("p1", "AGENTS.md");
    expect(seams.openTicketView).not.toHaveBeenCalled();
    expect(seams.projects.select.mock.invocationCallOrder[0]).toBeLessThan(
      seams.pinHomeFile.mock.invocationCallOrder[0]!,
    );
    expectNoListeners();
  });

  it("opens the requested Ticket Body without changing Home navigation or opening a file", async () => {
    seams.projects.projects = [{ id: "p1" }];
    routing.acceptWorkspaceNavigation({ kind: "ticket", projectId: "p1", ticketId: "t1" });
    await settle();
    expect(seams.projects.select).toHaveBeenCalledExactlyOnceWith("p1");
    expect(seams.openTicketView).toHaveBeenCalledExactlyOnceWith("p1", "t1", {
      tabId: TICKET_BODY_TAB_ID,
    });
    expect(seams.setNav).not.toHaveBeenCalled();
    expect(seams.pinHomeFile).not.toHaveBeenCalled();
  });

  it("parks a local presentation until its project arrives", async () => {
    routing.acceptWorkspaceNavigation({
      kind: "file",
      projectId: "restoring",
      relPath: "README.md",
    });
    await settle();
    expect(seams.pinHomeFile).not.toHaveBeenCalled();
    seams.projects.projects = [{ id: "restoring" }];
    notify();
    await settle();
    expect(seams.pinHomeFile).toHaveBeenCalledExactlyOnceWith("restoring", "README.md");
    expectNoListeners();
  });

  it("waits for the cloud client, accepted Workspace and its completed project roster", async () => {
    cloudWorkspace("w1", ["p1"]);
    seams.session = null;
    seams.sessionFixture.client.connectionState.mockReturnValue({ isWebSocketConnected: false });
    seams.selectWorkspace.mockImplementation(async (id) => {
      cloudWorkspace(id, [], false);
    });
    const preparation = routing.prepareWindowNavigation(
      { workspaceId: "w2", projectId: "p2" },
      request().signal,
    );
    let finished = false;
    void preparation.then(() => {
      finished = true;
    });
    await settle();
    expect(seams.selectWorkspace).not.toHaveBeenCalled();

    seams.session = seams.sessionFixture;
    seams.sessionFixture.client.connectionState.mockReturnValue({ isWebSocketConnected: true });
    notify();
    await settle();
    expect(seams.selectWorkspace).toHaveBeenCalledWith("w2", undefined, expect.any(AbortSignal));
    expect(finished).toBe(false);
    seams.projects.projects = [{ id: "p2" }];
    notify();
    await settle();
    expect(finished).toBe(false);
    seams.workspace.projectsReady = true;
    notify();
    await preparation;
    expect(finished).toBe(true);
    expectNoListeners();
  });

  it("can reveal an already accepted read-only snapshot without attempting a Workspace switch", async () => {
    cloudWorkspace("w2", ["p2"], false);
    seams.link.input.snapshotAt = 42;
    seams.link.input.online = false;
    await routing.prepareWindowNavigation({ workspaceId: "w2", projectId: "p2" }, request().signal);
    expect(seams.selectWorkspace).not.toHaveBeenCalled();
    expectNoListeners();
  });

  it("preserves the read-only failure when another Workspace cannot be selected", async () => {
    cloudWorkspace("w1", ["p1"]);
    seams.link.input.online = false;
    await expect(
      routing.prepareWindowNavigation({ workspaceId: "w2", projectId: "p2" }, request().signal),
    ).rejects.toThrow("Cloud is read-only");
    expect(seams.selectWorkspace).not.toHaveBeenCalled();
    expectNoListeners();
  });

  it("preserves selector permission failures without applying presentation", async () => {
    cloudWorkspace("w1", ["p1"]);
    seams.selectWorkspace.mockRejectedValueOnce(new Error("You are no longer a member."));
    routing.acceptWorkspaceNavigation({
      kind: "ticket",
      workspaceId: "w2",
      projectId: "p2",
      ticketId: "t2",
    });
    await settle();
    await settle();
    expect(seams.toastError).toHaveBeenCalledWith(
      "Couldn't open the workspace: You are no longer a member.",
    );
    expect(seams.projects.select).not.toHaveBeenCalled();
    expect(seams.openTicketView).not.toHaveBeenCalled();
    expectNoListeners();
  });

  it("rejects a missing project only after the accepted cloud roster answers", async () => {
    cloudWorkspace("w2", [], false);
    const preparation = routing.prepareWindowNavigation(
      { workspaceId: "w2", projectId: "removed" },
      request().signal,
    );
    const failed = expect(preparation).rejects.toThrow(
      "The project is no longer available in this Workspace.",
    );
    seams.workspace.projectsReady = true;
    notify();
    await failed;
    expectNoListeners();
  });

  it("releases every state subscription when the caller cancels preparation", async () => {
    const controller = request();
    const preparation = routing.prepareWindowNavigation(
      { projectId: "waiting" },
      controller.signal,
    );
    const cancelled = new Error("Navigation superseded");
    const failed = expect(preparation).rejects.toBe(cancelled);
    controller.abort(cancelled);
    await failed;
    expectNoListeners();
  });

  it("bounds preparation, aborts an unanswered selector, and does not serialize its successor behind it", async () => {
    cloudWorkspace("w1", ["p1"]);
    const old = deferred();
    seams.selectWorkspace.mockReturnValueOnce(old.promise).mockImplementationOnce(async (id) => {
      cloudWorkspace(id, ["p3"]);
    });
    const first = routing.prepareWindowNavigation(
      { workspaceId: "w2", projectId: "p2" },
      request().signal,
    );
    const failed = expect(first).rejects.toThrow("Check the connection and try again.");
    await settle();
    const oldSignal = seams.selectWorkspace.mock.calls[0]![2]!;
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(oldSignal.aborted).toBe(true);

    await routing.prepareWindowNavigation({ workspaceId: "w3", projectId: "p3" }, request().signal);
    expect(seams.selectWorkspace).toHaveBeenCalledTimes(2);
    expect(seams.workspace.workspace?.id).toBe("w3");
    old.resolve();
    await settle();
    expect(seams.workspace.workspace?.id).toBe("w3");
    expectNoListeners();
  });

  it("supersedes an old file request without letting its late preparation replace the new Ticket", async () => {
    cloudWorkspace("w1", ["p1"]);
    const old = deferred();
    seams.selectWorkspace.mockReturnValueOnce(old.promise);
    routing.acceptWorkspaceNavigation({
      kind: "file",
      workspaceId: "w2",
      projectId: "p2",
      relPath: "old.md",
    });
    await settle();
    const oldSignal = seams.selectWorkspace.mock.calls[0]![2]!;
    cloudWorkspace("w3", ["p3"]);
    routing.acceptWorkspaceNavigation({
      kind: "ticket",
      workspaceId: "w3",
      projectId: "p3",
      ticketId: "t3",
    });
    await settle();
    await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(seams.openTicketView).toHaveBeenCalledExactlyOnceWith("p3", "t3", {
      tabId: TICKET_BODY_TAB_ID,
    });
    old.resolve();
    await settle();
    expect(seams.pinHomeFile).not.toHaveBeenCalled();
    expect(seams.projects.select).toHaveBeenCalledExactlyOnceWith("p3");
    expect(seams.toastError).not.toHaveBeenCalled();
    expectNoListeners();
  });

  it("surfaces a bounded missing-project preparation instead of opening an unrelated local view", async () => {
    routing.acceptWorkspaceNavigation({ kind: "file", projectId: "missing", relPath: "README.md" });
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(seams.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Check the connection and try again."),
    );
    expect(seams.pinHomeFile).not.toHaveBeenCalled();
    expect(seams.projects.select).not.toHaveBeenCalled();
    expectNoListeners();
  });
});
